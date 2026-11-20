package server

import (
	_ "embed"
	"encoding/json"
)

//go:embed model_limits.json
var bundledModelLimitsJSON []byte

var bundledModelLimits = func() map[string][2]int {
	var models map[string][2]int
	if err := json.Unmarshal(bundledModelLimitsJSON, &models); err != nil {
		panic(err)
	}
	return models
}()

var modelLimitFields = [...]string{"contextWindow", "maxTokens"}
