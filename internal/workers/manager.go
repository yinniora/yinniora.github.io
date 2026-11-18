package workers

import (
	"context"
	"errors"
	"sync"
	"time"

	"pi-web/internal/chat"
)

type State string

const (
	WorkerStateIdle    State = "idle"
	WorkerStateRunning State = "running"
	WorkerStateError   State = "error"
)

type WorkerStatus struct {
	State          State        `json:"state"`
	Error          string       `json:"error,omitempty"`
	Model          string       `json:"model,omitempty"`
	ModelName      string       `json:"modelName,omitempty"`
	ModelProvider  string       `json:"modelProvider,omitempty"`
	ThinkingLevel  string       `json:"thinkingLevel,omitempty"`
	ThinkingLevels []string     `json:"thinkingLevels,omitempty"`
	Compacting     bool         `json:"compacting,omitempty"`
	HandledPrompt  string       `json:"handledPrompt,omitempty"`
	ExtensionUI    *ExtensionUI `json:"extensionUI,omitempty"`
}

// SlashCommand is a slash-invokable command exposed by a pi worker via the
// get_commands RPC. Source is one of "extension", "prompt", or "skill".
type SlashCommand struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Source      string `json:"source"`
}

// WorkerSnapshot is a point-in-time view of a single live worker for the
// metrics dashboard. PID/UptimeS/IdleForS are only populated for workers that
// implement the optional inspector interface (real pi processes); test fakes
// that don't will report zero values for those fields.
type WorkerSnapshot struct {
	SessionID string  `json:"session_id"`
	PID       int     `json:"pid"`
	State     State   `json:"state"`
	Model     string  `json:"model,omitempty"`
	UptimeS   float64 `json:"uptime_s"`
	IdleForS  float64 `json:"idle_for_s"`
}

// inspector is the optional interface a worker implements to expose
// process-level details for the metrics dashboard.
type inspector interface {
	PID() int
	StartedAt() time.Time
	IdleSince(now time.Time) time.Duration
}

type ChatWorker interface {
	Prompt(ctx context.Context, chat chat.Request) error
	SetModel(ctx context.Context, provider, modelID string) error
	SetThinkingLevel(ctx context.Context, level string) error
	Abort(ctx context.Context) error
	GetState(ctx context.Context) (WorkerStatus, error)
	GetCommands(ctx context.Context) ([]SlashCommand, error)
	Status() WorkerStatus
	Close() error
}

type Factory func(sessionID, sessionPath string) (ChatWorker, error)

type Manager struct {
	modelEpoch    uint64
	resourceEpoch uint64
	workerEpoch   map[string]uint64
	mu            sync.Mutex
	workers       map[string]ChatWorker
	creating      map[string]*createCall
	factory       Factory
	retired       map[string]bool

	// pendingSends counts Send calls that have been accepted but whose prompt
	// has not been acked yet. Spawning a worker (process start + switch_session
	// + get_state) can take seconds, and the worker only reports Running once
	// Prompt lands — without this, Status dips to idle mid-send, letting the
	// queue drainer dispatch queued items into a run that is still starting and
	// making status polls fire a spurious idle transition.
	pendingSends map[string]int

	idleTTL    time.Duration
	reaperStop chan struct{}
	reaperDone chan struct{}
}

type createCall struct {
	done   chan struct{}
	worker ChatWorker
	err    error
}

// DefaultIdleTTL is how long a worker may sit idle before the reaper closes it.
// The metrics dashboard uses it as the threshold for flagging "zombie" workers.
const DefaultIdleTTL = 10 * time.Minute

func NewManager(factory Factory) *Manager {
	return NewManagerWithTTL(factory, DefaultIdleTTL)
}

// NewManagerWithTTL is the same as NewManager but lets callers override the
// idle TTL. A non-positive ttl disables reaping.
func NewManagerWithTTL(factory Factory, ttl time.Duration) *Manager {
	m := &Manager{
		workers:      make(map[string]ChatWorker),
		workerEpoch:  make(map[string]uint64),
		creating:     make(map[string]*createCall),
		factory:      factory,
		retired:      make(map[string]bool),
		pendingSends: make(map[string]int),
		idleTTL:      ttl,
		reaperStop:   make(chan struct{}),
		reaperDone:   make(chan struct{}),
	}
	if ttl > 0 {
		go m.reapLoop()
	} else {
		close(m.reaperDone)
	}
	return m
}

func (m *Manager) reapLoop() {
	defer close(m.reaperDone)
	interval := m.idleTTL / 5
	if interval < time.Second {
		interval = time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-m.reaperStop:
			return
		case now := <-t.C:
			m.reapOnce(now)
		}
	}
}

func (m *Manager) reapOnce(now time.Time) {
	m.mu.Lock()
	var dead []ChatWorker
	for id, w := range m.workers {
		reaper, ok := w.(idleReportable)
		if !ok {
			continue
		}
		if w.Status().State != WorkerStateIdle {
			continue
		}
		if reaper.IdleSince(now) <= m.idleTTL {
			continue
		}
		dead = append(dead, w)
		delete(m.workers, id)
	}
	m.mu.Unlock()
	for _, w := range dead {
		_ = w.Close()
	}
}

func (m *Manager) Send(ctx context.Context, sessionID, sessionPath string, chat chat.Request) error {
	m.mu.Lock()
	m.refreshIdleResourcesLocked(sessionID)
	m.pendingSends[sessionID]++
	m.mu.Unlock()
	defer func() {
		// By the time Prompt returns (acked), the worker itself reports
		// Running, so the pending mark and the worker status overlap and the
		// session never observably dips to idle mid-send.
		m.mu.Lock()
		if m.pendingSends[sessionID]--; m.pendingSends[sessionID] <= 0 {
			delete(m.pendingSends, sessionID)
		}
		m.mu.Unlock()
	}()
	worker, err := m.workerFor(sessionID, sessionPath)
	if err != nil {
		return err
	}
	return worker.Prompt(ctx, chat)
}

// Snapshot returns a point-in-time view of every live worker, for the metrics
// dashboard. It does not spawn workers and never blocks on the workers
// themselves beyond reading their cached status.
func (m *Manager) Snapshot() []WorkerSnapshot {
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]WorkerSnapshot, 0, len(m.workers))
	for id, w := range m.workers {
		st := w.Status()
		snap := WorkerSnapshot{
			SessionID: id,
			State:     st.State,
			Model:     st.Model,
		}
		if ins, ok := w.(inspector); ok {
			snap.PID = ins.PID()
			if started := ins.StartedAt(); !started.IsZero() {
				snap.UptimeS = now.Sub(started).Seconds()
			}
			snap.IdleForS = ins.IdleSince(now).Seconds()
		}
		out = append(out, snap)
	}
	return out
}

func (m *Manager) Status(sessionID string) WorkerStatus {
	m.mu.Lock()
	pending := m.pendingSends[sessionID] > 0
	worker := m.workers[sessionID]
	m.mu.Unlock()
	if worker == nil {
		if pending {
			return WorkerStatus{State: WorkerStateRunning}
		}
		return WorkerStatus{State: WorkerStateIdle}
	}
	status := worker.Status()
	if pending && status.State == WorkerStateIdle {
		status.State = WorkerStateRunning
	}
	return status
}

func (m *Manager) SetModel(ctx context.Context, sessionID, sessionPath, provider, modelID string) error {
	for {
		worker, err := m.workerFor(sessionID, sessionPath)
		if err != nil {
			return err
		}
		m.mu.Lock()
		if m.workerEpoch[sessionID] == m.modelEpoch {
			m.mu.Unlock()
			return worker.SetModel(ctx, provider, modelID)
		}
		if m.pendingSends[sessionID] > 0 || worker.Status().State == WorkerStateRunning {
			m.mu.Unlock()
			return errors.New("finish the current reply before selecting a newly configured model")
		}
		// Close the idle worker before a replacement can be created for this session.
		err = worker.Close()
		delete(m.workers, sessionID)
		m.mu.Unlock()
		if err != nil {
			return err
		}
	}
}

// Active replies keep their process; the next idle model selection reloads config.
func (m *Manager) ModelsChanged() { m.mu.Lock(); m.modelEpoch++; m.mu.Unlock() }

// Existing responses finish with the resources they started with.
func (m *Manager) ResourcesChanged() {
	m.mu.Lock()
	m.modelEpoch++
	m.resourceEpoch = m.modelEpoch
	m.mu.Unlock()
}

func (m *Manager) refreshIdleResourcesLocked(sessionID string) {
	worker := m.workers[sessionID]
	if worker != nil && m.workerEpoch[sessionID] < m.resourceEpoch &&
		m.pendingSends[sessionID] == 0 && worker.Status().State == WorkerStateIdle {
		_ = worker.Close()
		delete(m.workers, sessionID)
		delete(m.workerEpoch, sessionID)
	}
}

func (m *Manager) SetThinkingLevel(ctx context.Context, sessionID, sessionPath, level string) error {
	worker, err := m.workerFor(sessionID, sessionPath)
	if err != nil {
		return err
	}
	return worker.SetThinkingLevel(ctx, level)
}

func (m *Manager) GetState(ctx context.Context, sessionID string) (WorkerStatus, error) {
	m.mu.Lock()
	worker := m.workers[sessionID]
	m.mu.Unlock()
	if worker == nil {
		return WorkerStatus{State: WorkerStateIdle}, nil
	}
	return worker.GetState(ctx)
}

// GetCommands peeks at an existing worker for the session and returns its
// slash commands. It never spawns a worker: if none exists yet it returns
// ready=false so callers can decide whether to spawn (via EnsureWorker) before
// retrying.
func (m *Manager) GetCommands(ctx context.Context, sessionID string) (cmds []SlashCommand, ready bool, err error) {
	m.mu.Lock()
	m.refreshIdleResourcesLocked(sessionID)
	worker := m.workers[sessionID]
	m.mu.Unlock()
	if worker == nil {
		return nil, false, nil
	}
	cmds, err = worker.GetCommands(ctx)
	return cmds, true, err
}

func (m *Manager) Abort(ctx context.Context, sessionID string) error {
	m.mu.Lock()
	worker := m.workers[sessionID]
	m.mu.Unlock()
	if worker == nil {
		return nil
	}
	return worker.Abort(ctx)
}

func (m *Manager) EnsureWorker(ctx context.Context, sessionID, sessionPath string) error {
	_, err := m.workerFor(sessionID, sessionPath)
	return err
}

func (m *Manager) Close() error {
	select {
	case <-m.reaperStop:
		// already closed
	default:
		close(m.reaperStop)
	}
	<-m.reaperDone

	m.mu.Lock()
	workers := make([]ChatWorker, 0, len(m.workers))
	for _, worker := range m.workers {
		workers = append(workers, worker)
	}
	m.workers = make(map[string]ChatWorker)
	m.mu.Unlock()
	var result error
	for _, worker := range workers {
		result = errors.Join(result, worker.Close())
	}
	return result
}

func (m *Manager) workerFor(sessionID, sessionPath string) (ChatWorker, error) {
	for {
		m.mu.Lock()
		if m.retired[sessionID] {
			m.mu.Unlock()
			return nil, errors.New("session permanently deleted")
		}
		m.refreshIdleResourcesLocked(sessionID)
		if worker := m.workers[sessionID]; worker != nil {
			if worker.Status().State != WorkerStateError {
				m.mu.Unlock()
				return worker, nil
			}
			delete(m.workers, sessionID)
			m.mu.Unlock()
			_ = worker.Close()
			continue
		}
		if call := m.creating[sessionID]; call != nil {
			m.mu.Unlock()
			<-call.done
			if call.err != nil {
				return nil, call.err
			}
			return call.worker, nil
		}
		call := &createCall{done: make(chan struct{})}
		epoch := m.modelEpoch
		m.creating[sessionID] = call
		m.mu.Unlock()

		worker, err := m.factory(sessionID, sessionPath)

		m.mu.Lock()
		if err == nil {
			if existing := m.workers[sessionID]; existing != nil && existing.Status().State != WorkerStateError {
				_ = worker.Close()
				worker = existing
			} else {
				m.workers[sessionID] = worker
				m.workerEpoch[sessionID] = epoch
			}
		}
		delete(m.creating, sessionID)
		call.worker = worker
		call.err = err
		close(call.done)
		m.mu.Unlock()
		return worker, err
	}
}

// RetireIdle prevents any later RPC from recreating a permanently deleted
// session, and closes the cached subprocess before its JSONL is removed.
func (m *Manager) RetireIdle(sessionID string) (func(), error) {
	m.mu.Lock()
	w := m.workers[sessionID]
	if m.pendingSends[sessionID] > 0 || m.creating[sessionID] != nil || (w != nil && w.Status().State == WorkerStateRunning) {
		m.mu.Unlock()
		return nil, errors.New("stop the running task before permanently deleting this session")
	}
	if m.retired == nil {
		m.retired = make(map[string]bool)
	}
	wasRetired := m.retired[sessionID]
	m.retired[sessionID] = true
	delete(m.workers, sessionID)
	m.mu.Unlock()
	rollback := func() {
		m.mu.Lock()
		if !wasRetired {
			delete(m.retired, sessionID)
		}
		m.mu.Unlock()
	}
	if w != nil {
		if err := w.Close(); err != nil {
			rollback()
			return nil, err
		}
	}
	return rollback, nil
}

type idleReportable interface {
	IdleSince(now time.Time) time.Duration
}

// RestoreSession allows a recovered conversation to start an RPC worker again.
func (m *Manager) RestoreSession(id string) { m.mu.Lock(); delete(m.retired, id); m.mu.Unlock() }
