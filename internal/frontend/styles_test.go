package frontend

import (
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestStylesheetManifestAndContentType(t *testing.T) {
	fsys := fstest.MapFS{
		".vite/manifest.json": {Data: []byte(`{"src/main.js":{"file":"assets/app.js","css":["assets/app.css"]}}`)},
		"assets/app.js":       {Data: []byte("console.log('app')")},
		"assets/app.css":      {Data: []byte(".menu{color:red}")},
	}
	scripts, err := LoadScripts(fsys, AppEntry)
	if err != nil || len(scripts) != 1 || len(scripts[0].CSS) != 1 || scripts[0].CSS[0] != "/static/assets/app.css" {
		t.Fatalf("missing CSS: %+v %v", scripts, err)
	}
	w := httptest.NewRecorder()
	ServeStaticAssets(fsys)(w, httptest.NewRequest("GET", "/static/assets/app.css", nil))
	if w.Code != 200 || w.Header().Get("Content-Type") != "text/css; charset=utf-8" || w.Body.String() != ".menu{color:red}" {
		t.Fatalf("bad CSS response: %d %s", w.Code, w.Header())
	}
}

func TestStylesheetManifestRejectsMissingOrUnsafePaths(t *testing.T) {
	for _, path := range []string{"../private.css", "/etc/file.css", "assets/missing.css"} {
		fsys := fstest.MapFS{".vite/manifest.json": {Data: []byte(`{"src/main.js":{"file":"assets/app.js","css":["` + path + `"]}}`)}, "assets/app.js": {Data: []byte("app")}}
		if _, err := LoadScripts(fsys, AppEntry); err == nil {
			t.Fatalf("accepted %s", path)
		}
	}
}
