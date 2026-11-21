package rpc

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pi-web/internal/chat"
)

func TestNeedsCompactionAccountsForInputAndCache(t *testing.T) {
	limits := model{ID: "opus", Provider: "local", ContextWindow: 1_000_000, MaxTokens: 64_000}
	now := time.Now().UTC()
	for _, test := range []struct {
		name        string
		modelID     string
		tokens      int
		cacheRead   int
		age         time.Duration
		promptBytes int
		trailing    string
		want        bool
	}{
		{name: "new prompt crosses early budget", modelID: "opus", tokens: 799_000, promptBytes: 8_000, want: true},
		{name: "long tool tail crosses early budget", modelID: "opus", tokens: 799_000, trailing: strings.Repeat("x", 8_000), want: true},
		{name: "recent cache can defer early compaction", modelID: "opus", tokens: 810_000, cacheRead: 800_000},
		{name: "cold cache restores early compaction", modelID: "opus", tokens: 810_000, cacheRead: 800_000, age: 6 * time.Minute, want: true},
		{name: "cache cannot waive output headroom", modelID: "opus", tokens: 933_000, cacheRead: 900_000, want: true},
		{name: "switching to smaller context", modelID: "wider", tokens: 945_000, cacheRead: 900_000, want: true},
		{name: "model switch with adequate headroom", modelID: "wider", tokens: 810_000},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := fmt.Sprintf(`{"type":"session","version":3}
{"type":"message","id":"reply","parentId":null,"timestamp":%q,"message":{"role":"assistant","stopReason":"stop","model":%q,"provider":"local","usage":{"input":%d,"cacheRead":%d}}}
`, now.Add(-test.age).Format(time.RFC3339Nano), test.modelID, test.tokens-test.cacheRead, test.cacheRead)
			if test.trailing != "" {
				fixture += fmt.Sprintf(`{"type":"message","id":"tail","parentId":"reply","message":{"role":"toolResult","content":[{"type":"text","text":%q}]}}`+"\n", test.trailing)
			}
			path := filepath.Join(t.TempDir(), "session.jsonl")
			if err := os.WriteFile(path, []byte(fixture), 0600); err != nil {
				t.Fatal(err)
			}
			request := chat.Request{Message: strings.Repeat("x", test.promptBytes)}
			if got := needsCompaction(path, limits, request); got != test.want {
				t.Errorf("needsCompaction = %v, want %v", got, test.want)
			}
		})
	}
}

func TestNeedsCompactionAfterArchivingFailedReply(t *testing.T) {
	limits := model{ID: "opus", Provider: "local", ContextWindow: 128_000, MaxTokens: 32_000}
	for _, test := range []struct {
		name        string
		content     string
		replacement string
		want        bool
	}{
		{name: "retain usage after empty network error", content: `[]`, replacement: `null`, want: true},
		{name: "defer to Pi if omitted reply contained text", content: `[{"type":"text","text":"partial"}]`, replacement: `null`},
		{name: "defer to Pi if content was replaced", content: `[]`, replacement: `[{"type":"text","text":"note"}]`},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := fmt.Sprintf(`{"type":"session","version":3}
{"type":"message","id":"last","parentId":null,"message":{"role":"assistant","stopReason":"stop","model":"opus","provider":"local","usage":{"totalTokens":95000}}}
{"type":"message","id":"error","parentId":"last","message":{"role":"assistant","stopReason":"error","content":%s,"usage":{"totalTokens":0}}}
{"type":"context_edit","id":"archive","parentId":"error","targetId":"error","replacement":%s}
`, test.content, test.replacement)
			path := filepath.Join(t.TempDir(), "session.jsonl")
			if err := os.WriteFile(path, []byte(fixture), 0600); err != nil {
				t.Fatal(err)
			}
			if got := needsCompaction(path, limits, chat.Request{Message: "Continue"}); got != test.want {
				t.Errorf("needsCompaction = %v, want %v", got, test.want)
			}
		})
	}
}
