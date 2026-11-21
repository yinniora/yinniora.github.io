package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"pi-web/internal/workers"
)

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	sessID := r.URL.Query().Get("id")
	if sessID == "" {
		http.Error(w, "missing id", 400)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	client := s.addClient(sessID)
	defer s.removeClient(client)

	fmt.Fprintf(w, ":ok\n\n")
	flusher.Flush()

	var previews chatPreviewBatch
	writePreview := func(pending pendingChatPreview) {
		writeChatPreview(w, flusher, pending.snapshot)
		if pending.reload && !pending.snapshot.Done {
			fmt.Fprint(w, "data: reload\n\n")
			flusher.Flush()
		}
	}
	if sessID == globalSessID {
		s.writeStatusSnapshot(w)
		// A device may have been offline when the send preference changed.
		settings := map[string]string{settingChatRunningSendMode: s.getSetting(settingChatRunningSendMode, "steer")}
		if msg, err := formatSSEJSONEvent("settings", map[string]any{"settings": settings}); err == nil {
			fmt.Fprint(w, msg+"\n\n")
		}
		flusher.Flush()
	} else if source, ok := s.chatSender.(interface {
		ChatPreview(string) (workers.LivePreview, bool)
	}); ok {
		if preview, active := source.ChatPreview(sessID); active {
			previews.offer(time.Now(), pendingChatPreview{snapshot: preview}, writePreview)
		}
	}

	var timer *time.Timer
	var previewDue <-chan time.Time
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	for {
		select {
		case pending := <-client.preview:
			if wait := previews.offer(time.Now(), pending, writePreview); wait > 0 {
				if previewDue == nil {
					if timer == nil {
						timer = time.NewTimer(wait)
					} else {
						timer.Reset(wait)
					}
					previewDue = timer.C
				}
			} else if previewDue != nil {
				timer.Stop()
				previewDue = nil
			}
		case <-previewDue:
			previewDue = nil
			previews.flush(time.Now(), writePreview)
		case msg, open := <-client.ch:
			if !open {
				return
			}
			if msg == "reload" && previewDue != nil {
				timer.Stop()
				previewDue = nil
				previews.flush(time.Now(), writePreview)
			}
			if key := eventKey(msg); key != "" {
				client.mu.Lock()
				delete(client.queued, key)
				client.mu.Unlock()
			}
			if strings.HasPrefix(msg, "event: ") {
				// Already-formatted named SSE event; pass through with the
				// terminating blank line.
				fmt.Fprint(w, msg+"\n\n")
			} else {
				fmt.Fprintf(w, "data: %s\n\n", msg)
			}
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

const chatPreviewInterval = 100 * time.Millisecond

// Each text snapshot is cumulative. Coalesce updates of the same assistant
// phase before serialization and delivery to local and encrypted clients.
type chatPreviewBatch struct {
	lastSent workers.LivePreview
	sentAt   time.Time
	pending  pendingChatPreview
	buffered bool
}

func (b *chatPreviewBatch) offer(now time.Time, next pendingChatPreview, emit func(pendingChatPreview)) time.Duration {
	wait := chatPreviewInterval - now.Sub(b.sentAt)
	latest := b.lastSent
	if b.buffered {
		latest = b.pending.snapshot
	}
	if next.snapshot.Revision != 0 && next.snapshot.Revision < latest.Revision {
		// Reconnect and concurrent producers can deliver an older revision.
		// Never replace the newer text, but still reconcile after a dropped Done.
		if next.reload || next.snapshot.Done {
			next = pendingChatPreview{snapshot: latest, reload: true}
			b.buffered = false
			b.pending = pendingChatPreview{}
		} else {
			if b.buffered && wait > 0 {
				return wait
			}
			b.flush(now, emit)
			return 0
		}
	}
	if !next.reload && sameStreamingActivity(b.lastSent, next.snapshot) {
		if wait > 0 {
			b.pending = next
			b.buffered = true
			return wait
		}
		// This is a newer complete snapshot of the same text. A due timer can
		// race this event, so use it instead of writing the older pending text.
		b.pending = pendingChatPreview{}
		b.buffered = false
	} else {
		b.flush(now, emit)
	}
	b.lastSent, b.sentAt = next.snapshot, now
	emit(next)
	return 0
}

func (b *chatPreviewBatch) flush(now time.Time, emit func(pendingChatPreview)) {
	if !b.buffered {
		return
	}
	next := b.pending
	b.pending = pendingChatPreview{}
	b.buffered = false
	b.lastSent, b.sentAt = next.snapshot, now
	emit(next)
}

func sameStreamingActivity(a, b workers.LivePreview) bool {
	if b.Done || (b.Phase != "thinking" && b.Phase != "reply") {
		return false
	}
	a.Content, b.Content = "", ""
	a.Thinking, b.Thinking = "", ""
	a.Revision, b.Revision = 0, 0
	return a == b
}

func writeChatPreview(w http.ResponseWriter, flusher http.Flusher, preview workers.LivePreview) {
	if msg, err := formatSSEJSONEvent("chat-preview", preview); err == nil {
		fmt.Fprint(w, msg+"\n\n")
		flusher.Flush()
	}
}

// writeStatusSnapshot emits a single SSE event listing every session id that
// is currently broadcast as running. Sorted for deterministic test output.
func (s *Server) writeStatusSnapshot(w http.ResponseWriter) {
	s.lastKnownMu.Lock()
	ids := make([]string, 0, len(s.lastKnown))
	for id := range s.lastKnown {
		ids = append(ids, id)
	}
	s.lastKnownMu.Unlock()
	sort.Strings(ids)

	var sb strings.Builder
	sb.WriteString(`{"running":[`)
	for i, id := range ids {
		if i > 0 {
			sb.WriteByte(',')
		}
		idJSON, _ := json.Marshal(id)
		sb.Write(idJSON)
	}
	sb.WriteString(`],"statuses":{`)
	for i, id := range ids {
		if i > 0 {
			sb.WriteByte(',')
		}
		idJSON, _ := json.Marshal(id)
		sb.Write(idJSON)
		sb.WriteByte(':')
		data, _ := json.Marshal(s.runningStatusPayload(id, true))
		sb.Write(data)
	}
	sb.WriteString("}}")

	fmt.Fprintf(w, "event: status-snapshot\ndata: %s\n\n", sb.String())
}
