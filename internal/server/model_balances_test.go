package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestNewAPIModelBalances(t *testing.T) {
	for _, test := range []struct {
		name, fields, status, scope, unit string
		amount                            float64
	}{
		{"account limits spend", `"total_available":800000,"user_quota":{"total_available":250000}`, "available", "account", "CNY", 3.5},
		{"zero key quota", `"total_available":0,"user_quota":{"total_available":250000}`, "available", "key", "CNY", 0},
		{"uncapped key account balance", `"unlimited_quota":true,"total_available":0,"user_quota":{"total_available":250000}`, "available", "account", "CNY", 3.5},
		{"uncapped key only", `"unlimited_quota":true,"total_available":0`, "unlimited", "", "", 0},
		{"account alone with unknown key limit", `"user_quota":{"total_available":250000}`, "available", "account", "CNY", 3.5},
		{"missing values", `"total_used":123`, "unavailable", "", "", 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			var usageCalls atomic.Int32
			service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/instance/api/usage/token/":
					usageCalls.Add(1)
					if r.Header.Get("Authorization") != "Bearer fixture-key" {
						t.Error("usage must use the saved key")
					}
					fmt.Fprintf(w, `{"code":true,"data":{"object":"token_usage",%s}}`, test.fields)
				case "/instance/api/status":
					if r.Header.Get("Authorization") != "" {
						t.Error("public status must not receive credentials")
					}
					fmt.Fprint(w, `{"success":true,"data":{"quota_per_unit":500000,"quota_display_type":"CNY","usd_exchange_rate":7}}`)
				default:
					http.NotFound(w, r)
				}
			}))
			defer service.Close()
			s := &Server{agentDir: t.TempDir()}
			config := fmt.Sprintf(`{"providers":{"fixture":{"baseUrl":%q,"api":"anthropic-messages","apiKey":"fixture-key"}}}`, service.URL+"/instance/v1")
			if err := writePrivateModelFile(filepath.Join(s.agentDir, "models.json"), []byte(config)); err != nil {
				t.Fatal(err)
			}
			for range 2 {
				w := httptest.NewRecorder()
				s.handleModelBalances(w, httptest.NewRequest(http.MethodGet, "/api/model-balances", nil))
				var payload struct{ Balances map[string]modelBalance }
				if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil || w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("balance response status=%d err=%v", w.Code, err)
				}
				balance := payload.Balances["fixture"]
				if balance.Status != test.status || balance.Scope != test.scope || balance.Unit != test.unit {
					t.Fatalf("balance = %+v, expected %s %s %s", balance, test.status, test.scope, test.unit)
				}
				if test.status == "available" && (balance.Amount == nil || *balance.Amount != test.amount) {
					t.Fatalf("expected balance amount %v, got %+v", test.amount, balance)
				}
			}
			if usageCalls.Load() != 1 {
				t.Fatalf("expected one fetch, got %d", usageCalls.Load())
			}
		})
	}
}

func TestBalanceLookupDoesNotSendKeyToRedirect(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("balance lookup followed an off-origin redirect")
	}))
	defer other.Close()
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	}))
	defer service.Close()
	u, err := url.Parse(service.URL + "/v1")
	if err != nil {
		t.Fatal(err)
	}
	if result := fetchNewAPIBalance(context.Background(), *u, "fixture-key"); result.Status != "unavailable" {
		t.Fatalf("redirect returned %+v", result)
	}
}
