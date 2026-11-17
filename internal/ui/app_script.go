package ui

// appScriptPath is the URL path at which the SPA's Vite module is served. It
// defaults to a stable path and is overwritten at startup when the hashed asset
// is found in the Vite manifest.
var appScriptPath = "/static/assets/app.js"
var appStylePaths []string

func SetAppScriptPath(path string)    { appScriptPath = path }
func SetAppStylePaths(paths []string) { appStylePaths = paths }
