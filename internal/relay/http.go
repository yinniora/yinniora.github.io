package relay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/pion/webrtc/v4"
)

const maxRequestBody = 36 * 1024 * 1024

type channelWriter struct {
	ctx     context.Context
	channel *webrtc.DataChannel
	mu      sync.Mutex
	low     chan struct{}
}

func newChannelWriter(ctx context.Context, channel *webrtc.DataChannel) *channelWriter {
	w := &channelWriter{ctx: ctx, channel: channel, low: make(chan struct{}, 1)}
	channel.SetBufferedAmountLowThreshold(128 * 1024)
	channel.OnBufferedAmountLow(func() {
		select {
		case w.low <- struct{}{}:
		default:
		}
	})
	return w
}

func (w *channelWriter) send(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	for w.channel.BufferedAmount() > 1024*1024 {
		select {
		case <-w.ctx.Done():
			return w.ctx.Err()
		case <-w.low:
		}
	}
	if err := w.ctx.Err(); err != nil {
		return err
	}
	return w.channel.SendText(string(data))
}

type packet struct {
	Type    string      `json:"type"`
	ID      string      `json:"id"`
	Method  string      `json:"method,omitempty"`
	Path    string      `json:"path,omitempty"`
	Headers http.Header `json:"headers,omitempty"`
	Size    int64       `json:"size,omitempty"`
	Data    string      `json:"data,omitempty"`
	Status  int         `json:"status,omitempty"`
}

type incomingRequest struct {
	flow   *responseFlow
	writer *io.PipeWriter
	cancel context.CancelFunc
	bytes  int64
	limit  int64
}

type responseFlow struct {
	mu     sync.Mutex
	credit int64
	wake   chan struct{}
}

func (f *responseFlow) add(credit int64) {
	if credit <= 0 || credit > 64*1024 {
		return
	}
	f.mu.Lock()
	f.credit = min(f.credit+credit, 1024*1024)
	f.mu.Unlock()
	select {
	case f.wake <- struct{}{}:
	default:
	}
}
func (f *responseFlow) take(ctx context.Context, size int64) error {
	for {
		f.mu.Lock()
		if f.credit >= size {
			f.credit -= size
			f.mu.Unlock()
			return nil
		}
		f.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-f.wake:
		}
	}
}

type httpBridge struct {
	ctx      context.Context
	writer   *channelWriter
	device   string
	handler  func(http.ResponseWriter, *http.Request, string)
	mu       sync.Mutex
	requests map[string]*incomingRequest
}

func newHTTPBridge(ctx context.Context, writer *channelWriter, device string, handler func(http.ResponseWriter, *http.Request, string)) *httpBridge {
	b := &httpBridge{ctx: ctx, writer: writer, device: device, handler: handler, requests: make(map[string]*incomingRequest)}
	go func() {
		<-ctx.Done()
		b.mu.Lock()
		defer b.mu.Unlock()
		for _, request := range b.requests {
			request.cancel()
			_ = request.writer.CloseWithError(ctx.Err())
		}
	}()
	return b
}

func validRequestPath(value string) bool {
	if len(value) > 8192 || !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") {
		return false
	}
	u, err := url.ParseRequestURI(value)
	if err != nil || u.IsAbs() {
		return false
	}
	return strings.HasPrefix(u.Path, "/api/") || u.Path == "/events" || strings.HasPrefix(u.Path, "/sounds/") || u.Path == "/share" || u.Path == "/export"
}

func (b *httpBridge) receive(data []byte) {
	var message packet
	if json.Unmarshal(data, &message) != nil || message.ID == "" || len(message.ID) > 64 {
		_ = b.writer.channel.Close()
		return
	}
	if message.Type == "request" {
		b.start(message)
		return
	}
	b.mu.Lock()
	request := b.requests[message.ID]
	b.mu.Unlock()
	if request == nil {
		return
	}
	switch message.Type {
	case "window":
		request.flow.add(message.Size)
	case "body":
		chunk, err := base64.StdEncoding.DecodeString(message.Data)
		if err != nil || len(chunk) > 32*1024 || request.bytes+int64(len(chunk)) > request.limit {
			request.cancel()
			_ = request.writer.CloseWithError(errors.New("request body limit exceeded"))
			return
		}
		request.bytes += int64(len(chunk))
		_, _ = request.writer.Write(chunk)
	case "body-end":
		_ = request.writer.Close()
	case "cancel":
		request.cancel()
		_ = request.writer.CloseWithError(context.Canceled)
	}
}

func (b *httpBridge) start(message packet) {
	if !validRequestPath(message.Path) || message.Size < 0 || message.Size > maxRequestBody ||
		(message.Method != "GET" && message.Method != "HEAD" && message.Method != "POST" && message.Method != "DELETE") {
		_ = b.writer.send(packet{Type: "response", ID: message.ID, Status: 400})
		_ = b.writer.send(packet{Type: "end", ID: message.ID})
		return
	}
	ctx, cancel := context.WithCancel(b.ctx)
	reader, writer := io.Pipe()
	b.mu.Lock()
	if b.requests[message.ID] != nil || len(b.requests) >= 24 {
		b.mu.Unlock()
		cancel()
		_ = reader.Close()
		_ = writer.Close()
		return
	}
	flow := &responseFlow{credit: 64 * 1024, wake: make(chan struct{}, 1)}
	b.requests[message.ID] = &incomingRequest{writer: writer, cancel: cancel, limit: message.Size, flow: flow}
	b.mu.Unlock()
	go func() {
		defer func() {
			cancel()
			_ = reader.Close()
			_ = writer.Close()
			b.mu.Lock()
			delete(b.requests, message.ID)
			b.mu.Unlock()
		}()
		request, err := http.NewRequestWithContext(ctx, message.Method, "http://localhost"+message.Path, reader)
		if err != nil {
			return
		}
		request.RemoteAddr = "approved-device:0"
		request.ContentLength = message.Size
		for _, key := range []string{"Accept", "Content-Type", "Range", "If-Modified-Since", "If-None-Match", "Last-Event-Id"} {
			for _, value := range message.Headers.Values(key) {
				if len(value) < 8192 && !strings.ContainsAny(value, "\r\n") {
					request.Header.Add(key, value)
				}
			}
		}
		response := &channelResponse{writer: b.writer, id: message.ID, headers: make(http.Header), flow: flow, ctx: ctx}
		b.handler(response, request, b.device)
		response.Flush()
		_ = b.writer.send(packet{Type: "end", ID: message.ID})
	}()
}

type channelResponse struct {
	flow    *responseFlow
	ctx     context.Context
	writer  *channelWriter
	id      string
	headers http.Header
	status  int
}

func (w *channelResponse) Header() http.Header { return w.headers }
func (w *channelResponse) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	headers := w.headers.Clone()
	headers.Del("Set-Cookie")
	headers.Del("Authorization")
	_ = w.writer.send(packet{Type: "response", ID: w.id, Status: status, Headers: headers})
}
func (w *channelResponse) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	written := 0
	for len(data) > 0 {
		n := min(len(data), 16*1024)
		if err := w.flow.take(w.ctx, int64(n)); err != nil {
			return written, err
		}
		if err := w.writer.send(packet{Type: "data", ID: w.id, Data: base64.StdEncoding.EncodeToString(data[:n])}); err != nil {
			return written, err
		}
		written += n
		data = data[n:]
	}
	return written, nil
}
func (w *channelResponse) Flush() {
	if w.status == 0 {
		w.WriteHeader(200)
	}
}
