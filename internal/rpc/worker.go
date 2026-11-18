package rpc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"pi-web/internal/chat"
	"pi-web/internal/workers"
)

type piRPCWorker struct {
	mu                   sync.Mutex
	writeMu              sync.Mutex
	modelMu              sync.Mutex
	sessionPath          string
	startedAt            time.Time
	cmd                  *exec.Cmd
	stdin                io.WriteCloser
	status               workers.WorkerStatus
	seq                  atomic.Uint64
	pending              map[string]chan response
	currentModel         string
	currentProvider      string
	currentThinkingLevel string
	thinkingLevels       []string
	thinkingLevelsLoaded bool
	stderrBuf            *strings.Builder
	commands             []workers.SlashCommand
	commandsCached       bool
	lastActive           atomic.Int64 // unix nanos; only user-initiated actions update this
	lastStreamActivity   atomic.Int64 // unix nanos; stream/turn events keep worker visually running
	streamSink           StreamEventSink
	streamPreview        *streamPreviewAccumulator
	computerMode         func() string
	computerRequests     map[string]workers.ComputerRequest
	compacting           bool
	agentRevision        uint64
	handledPrompt        string
	extensionDialogs     map[string]*pendingExtensionDialog
	extensionNotices     []workers.ExtensionNotice
	extensionClosed      bool
}

func (w *piRPCWorker) touch() {
	w.lastActive.Store(time.Now().UnixNano())
}

func (w *piRPCWorker) IdleSince(now time.Time) time.Duration {
	last := w.lastActive.Load()
	if last == 0 {
		return 0
	}
	return now.Sub(time.Unix(0, last))
}

// PID returns the operating-system process ID of the underlying pi worker, or
// 0 if the process has not started or has already exited.
func (w *piRPCWorker) PID() int {
	if w.cmd == nil || w.cmd.Process == nil {
		return 0
	}
	return w.cmd.Process.Pid
}

// StartedAt reports when the worker process was spawned (for uptime).
func (w *piRPCWorker) StartedAt() time.Time {
	return w.startedAt
}

// workerDir is the cwd for `pi --mode rpc`. Extensions load at process start
// from cwd, so inheriting pi-web's own checkout would load this repo's
// .pi/extensions on top of the globally installed package and crash on a
// duplicate tool (pi_web_ask_user_question). Prefer the session's project
// directory; fall back to temp so the server cwd is never inherited.
func workerDir(sessionPath string) string {
	if cwd := sessionHeaderCWD(sessionPath); cwd != "" {
		if info, err := os.Stat(cwd); err == nil && info.IsDir() {
			return cwd
		}
	}
	return detachedPiDir()
}

// detachedPiDir is a cwd with no project .pi/extensions. The installed
// LaunchAgent uses /tmp for the same reason: pi loads project extensions from
// cwd, and this repo's tools collide with `pi install npm:@ygncode/pi-web`.
func detachedPiDir() string {
	return os.TempDir()
}

func sessionHeaderCWD(sessionPath string) string {
	f, err := os.Open(sessionPath)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	if !sc.Scan() {
		return ""
	}
	var hdr struct {
		Type string `json:"type"`
		CWD  string `json:"cwd"`
	}
	if json.Unmarshal(sc.Bytes(), &hdr) != nil || hdr.Type != "session" {
		return ""
	}
	return strings.TrimSpace(hdr.CWD)
}

func NewPiWorkerWithStream(sessionPath string, streamSink StreamEventSink, guardPath string, computerMode func() string) (workers.ChatWorker, error) {
	if _, err := exec.LookPath("pi"); err != nil {
		return nil, fmt.Errorf("pi executable not found: %w", err)
	}
	args := []string{"--mode", "rpc"}
	if guardPath != "" {
		args = append(args, "-e", guardPath)
	}
	cmd := exec.Command("pi", args...)
	cmd.Dir = workerDir(sessionPath)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderrBuf strings.Builder
	cmd.Stderr = &stderrBuf
	worker := &piRPCWorker{
		sessionPath:   sessionPath,
		startedAt:     time.Now(),
		cmd:           cmd,
		stdin:         stdin,
		status:        workers.WorkerStatus{State: workers.WorkerStateIdle},
		pending:       make(map[string]chan response),
		stderrBuf:     &stderrBuf,
		streamSink:    streamSink,
		computerMode:  computerMode,
		streamPreview: &streamPreviewAccumulator{},
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go worker.consume(stdout)
	go worker.wait()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := worker.switchSession(ctx); err != nil {
		_ = worker.Close()
		return nil, err
	}
	if guardPath != "" {
		commands, err := worker.GetCommands(ctx)
		if err != nil || !slices.ContainsFunc(commands, func(c workers.SlashCommand) bool {
			return c.Name == "yugo-computer-guard-ready" && c.Source == "extension"
		}) {
			_ = worker.Close()
			return nil, errors.New("computer approval extension failed to load")
		}
	}
	// Best-effort: refresh model/thinking-level from pi so a respawned worker
	// doesn't show stale defaults after the in-memory cache was lost on reap.
	stateCtx, stateCancel := context.WithTimeout(context.Background(), 5*time.Second)
	_, stateErr := worker.GetState(stateCtx)
	stateCancel()
	if errors.Is(stateErr, errWorkerSessionChanged) {
		_ = worker.Close()
		return nil, stateErr
	}
	worker.touch()
	return worker, nil
}

func (w *piRPCWorker) Prompt(ctx context.Context, chat chat.Request) error {
	w.touch()
	w.mu.Lock()
	if w.compacting {
		w.mu.Unlock()
		return workers.ErrPiSessionBusy
	}
	streaming := w.status.State == workers.WorkerStateRunning
	revision := w.agentRevision
	w.status.State = workers.WorkerStateRunning
	w.status.Error = ""
	w.mu.Unlock()
	id := w.nextID()
	data, err := w.request(ctx, BuildPromptCommand(id, chat, streaming))
	if err != nil {
		w.mu.Lock()
		if w.agentRevision == revision && !streaming {
			w.status.State = workers.WorkerStateError
			w.status.Error = err.Error()
		}
		w.mu.Unlock()
		return err
	}
	var ack struct{ Disposition string }
	if json.Unmarshal(data, &ack) == nil && ack.Disposition == "handled" {
		stateCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		if _, err := w.GetState(stateCtx); errors.Is(err, errWorkerSessionChanged) {
			return err
		}
		w.mu.Lock()
		if !streaming && w.agentRevision == revision {
			w.status.State = workers.WorkerStateIdle
		}
		w.handledPrompt = strconv.FormatInt(w.startedAt.UnixNano(), 10) + "-" + id
		w.mu.Unlock()
	}
	return nil
}

func (w *piRPCWorker) SetModel(ctx context.Context, provider, modelID string) error {
	w.modelMu.Lock()
	defer w.modelMu.Unlock()
	if w.Status().Compacting {
		return workers.ErrPiSessionBusy
	}
	w.touch()
	data, err := w.request(ctx, map[string]any{
		"id":       w.nextID(),
		"type":     "set_model",
		"provider": provider,
		"modelId":  modelID,
	})
	if err != nil {
		return err
	}
	var result struct {
		model
		Wrapped model `json:"model"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return err
	}
	m := result.model
	if m.ID == "" {
		m = result.Wrapped
	}
	if m.ID == "" {
		return errors.New("set_model returned empty model id")
	}
	if m.Provider != provider || m.ID != modelID {
		return fmt.Errorf("set_model returned unexpected model: %s/%s (wanted %s/%s)", m.Provider, m.ID, provider, modelID)
	}
	w.mu.Lock()
	w.thinkingLevels = nil
	w.thinkingLevelsLoaded = false
	w.currentThinkingLevel = ""
	w.currentModel = m.ID
	w.currentProvider = m.Provider
	w.status.ModelName = m.Name
	if w.status.State != workers.WorkerStateRunning {
		w.status.State = workers.WorkerStateIdle
		w.status.Error = ""
	}
	w.mu.Unlock()
	return nil
}

func (w *piRPCWorker) SetThinkingLevel(ctx context.Context, level string) error {
	w.modelMu.Lock()
	defer w.modelMu.Unlock()
	if w.Status().Compacting {
		return workers.ErrPiSessionBusy
	}
	w.touch()
	return w.sendAndAwait(ctx, BuildSetThinkingLevelCommand(w.nextID(), level))
}

func (w *piRPCWorker) Abort(ctx context.Context) error {
	w.touch()
	if err := w.sendAndAwait(ctx, BuildAbortCommand(w.nextID())); err != nil {
		return err
	}
	w.mu.Lock()
	w.status.State = workers.WorkerStateIdle
	w.status.Error = ""
	w.mu.Unlock()
	return nil
}

func (w *piRPCWorker) GetState(ctx context.Context) (workers.WorkerStatus, error) {
	w.modelMu.Lock()
	defer w.modelMu.Unlock()
	data, err := w.request(ctx, BuildGetStateCommand(w.nextID()))
	if err != nil {
		return workers.WorkerStatus{}, err
	}
	var state struct {
		ThinkingLevel string `json:"thinkingLevel"`
		Model         model  `json:"model"`
		SessionFile   string `json:"sessionFile"`
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return workers.WorkerStatus{}, err
	}
	if w.sessionPath != "" && state.SessionFile != "" && !sameSessionFile(w.sessionPath, state.SessionFile) {
		w.setError(errWorkerSessionChanged)
		_ = w.Close()
		return workers.WorkerStatus{}, errWorkerSessionChanged
	}
	w.mu.Lock()
	w.currentThinkingLevel = state.ThinkingLevel
	if state.Model.ID != "" {
		if state.Model.ID != w.currentModel || state.Model.Provider != w.currentProvider {
			w.thinkingLevels = nil
			w.thinkingLevelsLoaded = false
		}
		w.currentModel = state.Model.ID
		w.currentProvider = state.Model.Provider
		w.status.ModelName = state.Model.Name
	}
	currentID, currentProvider := w.currentModel, w.currentProvider
	loadLevels := currentID != "" && !w.thinkingLevelsLoaded
	w.mu.Unlock()
	if loadLevels {
		w.loadThinkingLevels(ctx, currentProvider, currentID)
	}
	return w.Status(), nil
}

func (w *piRPCWorker) loadThinkingLevels(ctx context.Context, provider, id string) {
	data, err := w.request(ctx, map[string]any{"id": w.nextID(), "type": "get_available_thinking_levels"})
	if ctx.Err() != nil {
		return
	}
	var result struct {
		Levels []string `json:"levels"`
	}
	if err == nil {
		_ = json.Unmarshal(data, &result)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.currentProvider == provider && w.currentModel == id {
		w.thinkingLevels = result.Levels
		w.thinkingLevelsLoaded = true
	}
}

// GetCommands returns the slash commands pi loaded for this session (skills,
// prompt templates, and extension commands). The set is fixed for a worker's
// lifetime, so the first successful result is cached and reused. It does not
// call touch(): querying commands is a passive UI affordance and should not
// keep an idle worker alive.
func (w *piRPCWorker) GetCommands(ctx context.Context) ([]workers.SlashCommand, error) {
	w.mu.Lock()
	if w.commandsCached {
		cmds := w.commands
		w.mu.Unlock()
		return cmds, nil
	}
	w.mu.Unlock()

	id := w.nextID()
	ch := make(chan response, 1)
	w.mu.Lock()
	w.pending[id] = ch
	w.mu.Unlock()

	w.writeMu.Lock()
	err := WriteCommand(w.stdin, BuildGetCommandsCommand(id))
	w.writeMu.Unlock()
	if err != nil {
		w.removePending(id)
		return nil, err
	}

	select {
	case res := <-ch:
		if !res.Success {
			if res.Error != "" {
				return nil, errors.New(res.Error)
			}
			return nil, fmt.Errorf("rpc get_commands rejected")
		}
		var payload struct {
			Commands []workers.SlashCommand `json:"commands"`
		}
		if err := json.Unmarshal(res.Data, &payload); err != nil {
			return nil, err
		}
		w.mu.Lock()
		w.commands = payload.Commands
		w.commandsCached = true
		w.mu.Unlock()
		return payload.Commands, nil
	case <-ctx.Done():
		w.removePending(id)
		return nil, ctx.Err()
	}
}

const streamActivityWindow = 2 * time.Second

func (w *piRPCWorker) Status() workers.WorkerStatus {
	w.mu.Lock()
	defer w.mu.Unlock()
	s := w.status
	s.Model = w.currentModel
	s.ModelProvider = w.currentProvider
	s.ThinkingLevel = w.currentThinkingLevel
	s.ThinkingLevels = w.thinkingLevels
	s.HandledPrompt = w.handledPrompt
	if w.compacting {
		s.Compacting = true
		s.State = workers.WorkerStateRunning
	}
	if s.State == workers.WorkerStateIdle && w.hasRecentStreamActivityLocked(time.Now()) {
		s.State = workers.WorkerStateRunning
	}
	return s
}

func (w *piRPCWorker) Close() error {
	w.mu.Lock()
	w.extensionClosed = true
	for _, pending := range w.extensionDialogs {
		pending.timer.Stop()
	}
	clear(w.extensionDialogs)
	w.mu.Unlock()
	if w.stdin != nil {
		_ = w.stdin.Close()
	}
	if w.cmd != nil && w.cmd.Process != nil {
		_ = w.cmd.Process.Kill()
	}
	return nil
}

func (w *piRPCWorker) nextID() string {
	return fmt.Sprintf("req-%d", w.seq.Add(1))
}

func (w *piRPCWorker) switchSession(ctx context.Context) error {
	data, err := w.request(ctx, buildSwitchSessionCommand(w.nextID(), w.sessionPath))
	if err != nil {
		return err
	}
	var result struct{ Cancelled bool }
	if json.Unmarshal(data, &result) == nil && result.Cancelled {
		return errors.New("Pi extension cancelled loading the conversation")
	}
	return nil
}

var errWorkerSessionChanged = errors.New("Pi worker switched away from the current conversation")

func sameSessionFile(expected, actual string) bool {
	if filepath.Clean(expected) == filepath.Clean(actual) {
		return true
	}
	want, wantErr := os.Stat(expected)
	got, gotErr := os.Stat(actual)
	return wantErr == nil && gotErr == nil && os.SameFile(want, got)
}

func (w *piRPCWorker) sendAndAwait(ctx context.Context, cmd map[string]any) error {
	_, err := w.request(ctx, cmd)
	return err
}

func (w *piRPCWorker) request(ctx context.Context, cmd map[string]any) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	id, _ := cmd["id"].(string)
	if id == "" {
		return nil, errors.New("rpc command missing id")
	}
	ch := make(chan response, 1)
	w.mu.Lock()
	w.pending[id] = ch
	w.mu.Unlock()

	w.writeMu.Lock()
	err := WriteCommand(w.stdin, cmd)
	w.writeMu.Unlock()
	if err != nil {
		w.removePending(id)
		return nil, err
	}

	select {
	case res := <-ch:
		if !res.Success {
			if res.Error != "" {
				return nil, errors.New(res.Error)
			}
			return nil, fmt.Errorf("rpc %s rejected", res.Command)
		}
		return res.Data, nil
	case <-ctx.Done():
		w.removePending(id)
		return nil, ctx.Err()
	}
}

func (w *piRPCWorker) removePending(id string) {
	w.mu.Lock()
	delete(w.pending, id)
	w.mu.Unlock()
}

func (w *piRPCWorker) consume(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		w.handleRPCLine(line)
	}
	if err := scanner.Err(); err != nil {
		w.setError(err)
		return
	}
	w.setError(io.ErrUnexpectedEOF)
}

func (w *piRPCWorker) handleRPCLine(line string) {
	var meta struct {
		Type       string                `json:"type"`
		Level      string                `json:"level"`
		ToolCallID string                `json:"toolCallId"`
		ToolName   string                `json:"toolName"`
		Message    struct{ Role string } `json:"message"`
	}
	if err := json.Unmarshal([]byte(line), &meta); err != nil {
		return
	}
	switch meta.Type {
	case "extension_ui_request":
		w.handleExtensionUI(line)
	case "response":
		var res response
		if err := json.Unmarshal([]byte(line), &res); err != nil {
			return
		}
		w.mu.Lock()
		ch := w.pending[res.ID]
		delete(w.pending, res.ID)
		w.mu.Unlock()
		if ch != nil {
			ch <- res
		}
	case "message_update":
		var msg struct {
			AssistantMessageEvent assistantMessageEvent `json:"assistantMessageEvent"`
		}
		if err := json.Unmarshal([]byte(line), &msg); err == nil {
			w.emitStreamPreview(msg.AssistantMessageEvent)
		}
		w.noteStreamActivity()
	case "auto_retry_start":
		// Cancel Pi's pending backoff for this web turn without rewriting CLI settings.
		w.writeMu.Lock()
		_ = WriteCommand(w.stdin, map[string]any{"type": "abort_retry"})
		w.writeMu.Unlock()
	case "message_end":
		w.noteStreamActivity()
		if meta.Message.Role == "assistant" || meta.Message.Role == "" {
			w.emitStreamPreview(assistantMessageEvent{Type: meta.Type})
		}
	case "turn_end":
		w.noteStreamActivity()
	case "tool_execution_start", "tool_execution_end":
		w.noteStreamActivity()
		w.emitStreamPreview(assistantMessageEvent{Type: meta.Type, ToolCallID: meta.ToolCallID, ToolName: meta.ToolName})
	case "agent_start":
		w.mu.Lock()
		w.agentRevision++
		w.status.State = workers.WorkerStateRunning
		w.status.Error = ""
		w.mu.Unlock()
		w.emitStreamPreview(assistantMessageEvent{Type: meta.Type})
	case "agent_end":
		w.mu.Lock()
		w.agentRevision++
		w.status = workers.WorkerStatus{State: workers.WorkerStateIdle}
		clear(w.computerRequests)
		w.mu.Unlock()
		w.lastStreamActivity.Store(0)
		w.emitStreamPreview(assistantMessageEvent{Type: meta.Type})
	case "thinking_level_changed":
		if meta.Level != "" {
			w.mu.Lock()
			w.currentThinkingLevel = meta.Level
			w.mu.Unlock()
		}
	}
}

func (w *piRPCWorker) noteStreamActivity() {
	w.lastStreamActivity.Store(time.Now().UnixNano())
}

func (w *piRPCWorker) emitStreamPreview(event assistantMessageEvent) {
	if w.streamSink == nil || w.streamPreview == nil {
		return
	}
	w.mu.Lock()
	preview, ok := w.streamPreview.handleAssistantEvent(event)
	w.mu.Unlock()
	if ok {
		w.streamSink(preview)
	}
}

func (w *piRPCWorker) ChatPreview() (workers.LivePreview, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.streamPreview != nil && w.status.State != workers.WorkerStateError {
		if w.streamPreview.phase != "" {
			return w.streamPreview.snapshot(), true
		}
		if w.status.State == workers.WorkerStateRunning {
			return workers.LivePreview{Phase: "working"}, true
		}
	}
	return workers.LivePreview{}, false
}

func (w *piRPCWorker) hasRecentStreamActivityLocked(now time.Time) bool {
	last := w.lastStreamActivity.Load()
	if last == 0 {
		return false
	}
	return now.Sub(time.Unix(0, last)) <= streamActivityWindow
}

func (w *piRPCWorker) wait() {
	if err := w.cmd.Wait(); err != nil {
		w.setError(err)
	}
}

func (w *piRPCWorker) setError(err error) {
	err = w.withStderr(err)
	w.mu.Lock()
	if w.status.State != workers.WorkerStateError {
		w.status = workers.WorkerStatus{State: workers.WorkerStateError, Error: err.Error()}
	}
	for id, ch := range w.pending {
		delete(w.pending, id)
		ch <- response{ID: id, Type: "response", Success: false, Error: err.Error()}
	}
	w.mu.Unlock()
	w.emitStreamPreview(assistantMessageEvent{Type: "agent_end"})
}

func (w *piRPCWorker) withStderr(err error) error {
	if w.stderrBuf == nil {
		return err
	}
	stderr := strings.TrimSpace(w.stderrBuf.String())
	if stderr == "" {
		return err
	}
	const maxStderr = 4096
	if len(stderr) > maxStderr {
		stderr = "…" + stderr[len(stderr)-maxStderr:]
	}
	return fmt.Errorf("%w; stderr: %s", err, stderr)
}
