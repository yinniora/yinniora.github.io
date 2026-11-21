package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"pi-web/internal/chat"
	"pi-web/internal/chatqueue"
	"pi-web/internal/sessions"
	"pi-web/internal/workers"
)

// queueDrainer is the autonomous worker that pulls items off the per-session
// chat_queue and feeds them to the chat sender, whether or not anyone has the
// session open in a browser.
//
// Wake-up paths:
//
//   - kick(sessionID): called by the chat-queue HTTP handlers and by the
//     status sweeper when a worker transitions to idle. Cheap and immediate.
//   - periodic tick: a safety net that catches sessions whose kick was
//     dropped (the kick channel is bounded) or that ended up paused-then-
//     unpaused via another tab.
//   - startup: drain once when the drainer starts so items from a previous
//     server run pick up automatically.
//
// Concurrency: the drainer runs a single goroutine that processes one
// dispatch at a time. We rely on ChatSender.Status (cheap) to avoid
// double-dispatching while a previous Send is still streaming.
type queueDrainer struct {
	server     *Server
	kickCh     chan string
	stopCh     chan struct{}
	doneCh     chan struct{}
	tickPeriod time.Duration
	nowFn      func() time.Time

	// dispatchTimeout caps how long a single Send may block before we give up
	// on it. The dispatch goroutine will continue in the background; we just
	// stop blocking the drainer loop on it.
	dispatchTimeout time.Duration
}

func newQueueDrainer(s *Server) *queueDrainer {
	return &queueDrainer{
		server:          s,
		kickCh:          make(chan string, 64),
		stopCh:          make(chan struct{}),
		doneCh:          make(chan struct{}),
		tickPeriod:      5 * time.Second,
		nowFn:           time.Now,
		dispatchTimeout: queueSendTimeout,
	}
}

func (d *queueDrainer) start() {
	go d.run()
}

func (d *queueDrainer) stop() {
	close(d.stopCh)
	<-d.doneCh
}

// kick asks the drainer to re-evaluate one session promptly. Safe to call
// from any goroutine; never blocks.
func (d *queueDrainer) kick(sessionID string) {
	if d == nil || sessionID == "" {
		return
	}
	select {
	case d.kickCh <- sessionID:
	default:
		// Buffer full — the drainer's about to wake up anyway from a tick or
		// another kick. Dropping is safe because drainAll() catches up.
	}
}

func (d *queueDrainer) run() {
	defer close(d.doneCh)
	// Initial scan: pick up any items left from a previous server run.
	d.drainAll()
	ticker := time.NewTicker(d.tickPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-d.stopCh:
			return
		case sessionID := <-d.kickCh:
			d.drainSession(sessionID)
		case <-ticker.C:
			d.drainAll()
		}
	}
}

func (d *queueDrainer) drainAll() {
	if d.server.chatQueue == nil {
		return
	}
	ids, err := d.server.chatQueue.SessionsWithItems()
	if err != nil {
		fmt.Fprintf(os.Stderr, "queue drainer: list sessions: %v\n", err)
		return
	}
	for _, id := range ids {
		d.drainSession(id)
	}
}

func (d *queueDrainer) drainSession(sessionID string) {
	if hidden, err := d.server.sessionTrashed(sessionID); err != nil || hidden {
		return
	}
	if sessionID == "" {
		return
	}
	if d.server.chatQueue == nil || d.server.chatSender == nil {
		return
	}
	if _, busy := d.server.queueDispatches.LoadOrStore(sessionID, struct{}{}); busy {
		return
	}
	dispatched := false
	defer func() {
		if !dispatched {
			d.server.queueDispatches.Delete(sessionID)
		}
	}()
	// The worker writes a network-failure pause before becoming idle. Check
	// its state first so the next dispatch observes that persisted pause.
	if d.server.chatSender.Status(sessionID).State == workers.WorkerStateRunning {
		return
	}
	paused, err := d.server.chatQueue.IsPaused(sessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "queue drainer: IsPaused %s: %v\n", sessionID, err)
		return
	}
	if paused {
		return
	}
	// Resolve the on-disk path so chatSender can spawn the worker if needed.
	resolved, err := sessions.ResolveByID(d.server.sessionsDir, sessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "queue drainer: resolve %s: %v\n", sessionID, err)
		return
	}
	if !resolved.Session.ChatAvailable {
		// Chat is disabled for this session (e.g., its working directory was
		// removed). Leave the items in the queue; the user can clear them
		// from the UI.
		return
	}
	item, ok, err := d.server.chatQueue.Find(sessionID, 0)
	if err != nil {
		fmt.Fprintf(os.Stderr, "queue drainer: find head %s: %v\n", sessionID, err)
		return
	}
	if !ok {
		return
	}
	dispatched = d.server.startTask(func(taskCtx context.Context) {
		defer d.server.queueDispatches.Delete(sessionID)
		ctx, cancel := context.WithTimeout(taskCtx, d.dispatchTimeout)
		defer cancel()
		if err := d.server.sendQueued(ctx, resolved.Path, item, true); err != nil &&
			!errors.Is(err, workers.ErrPiSessionBusy) && !errors.Is(taskCtx.Err(), context.Canceled) {
			fmt.Fprintf(os.Stderr,
				"queue drainer: Send %s position %d failed: %v\n",
				sessionID, item.Position, err)
		}
	})
}

func (s *Server) sendQueued(ctx context.Context, path string, item chatqueue.Item, onlyWhenIdle bool) error {
	var request chat.Request
	var err error
	if item.HasAttachments {
		err = json.Unmarshal(item.Attachments, &request)
	}
	request.Message = item.Message
	request.OnlyWhenIdle = onlyWhenIdle
	var uploadDir string
	if err == nil {
		uploadDir, err = s.saveChatFiles(item.SessionID, &request)
	}
	if err == nil {
		err = s.chatSender.Send(ctx, item.SessionID, path, request)
	}
	if err == nil {
		err = s.chatQueue.Remove(item.SessionID, item.Position)
	}
	if errors.Is(err, workers.ErrPiSessionBusy) {
		if uploadDir != "" {
			_ = os.RemoveAll(uploadDir)
		}
		return err
	}
	if err != nil {
		// A missing acknowledgement can mean the send was accepted. Require
		// an explicit resume before another automatic attempt.
		err = errors.Join(err, s.chatQueue.SetPaused(item.SessionID, true))
	}
	s.notifyQueueChanged(item.SessionID)
	return err
}
