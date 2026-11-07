package inline

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, root, rel, body string) {
	t.Helper()
	p := filepath.Join(root, rel)
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSpec(t *testing.T) {
	root := t.TempDir()
	write(t, root, ".dub/evidence/ac.spec.ts", "import { test, expect } from '@dub/test';\nimport { login } from './helpers';\nimport pages from '../pages';\nimport './side';\nconst x = require('./cjs');\n")
	write(t, root, ".dub/evidence/helpers.ts", "import { test } from '@playwright/test';\nimport { login } from './helpers'; // cycle\nexport * from '../pages/index';\nexport function login() {}\n")
	write(t, root, ".dub/pages/index.ts", "export default {}\n")
	write(t, root, ".dub/evidence/side.ts", "// side effect")
	write(t, root, ".dub/evidence/cjs.js", "module.exports = require('fs')\n")
	write(t, root, ".dub/evidence/node_modules/x/index.ts", "nope")
	write(t, root, ".dub/evidence/nm.spec.ts", "import x from './node_modules/x'\n")

	r, err := Spec(root, filepath.Join(root, ".dub/evidence/ac.spec.ts"))
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, f := range r.Files {
		paths = append(paths, f.Path)
		if len(f.SHA256) != 64 {
			t.Errorf("bad hash %q", f.SHA256)
		}
	}
	want := []string{".dub/evidence/ac.spec.ts", ".dub/evidence/helpers.ts", ".dub/pages/index.ts", ".dub/evidence/side.ts", ".dub/evidence/cjs.js"}
	if strings.Join(paths, ",") != strings.Join(want, ",") {
		t.Errorf("files %v\nwant %v", paths, want)
	}
	if strings.Join(r.ExternalImports, ",") != "@dub/test,@playwright/test,fs" {
		t.Errorf("external %v", r.ExternalImports)
	}
	if !strings.HasPrefix(r.Source, "// ---- .dub/evidence/ac.spec.ts\nimport") || !strings.Contains(r.Source, "// ---- .dub/pages/index.ts\n") {
		t.Errorf("source:\n%s", r.Source)
	}

	r, err = Spec(root, filepath.Join(root, ".dub/evidence/nm.spec.ts"))
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Files) != 1 || len(r.ExternalImports) != 1 {
		t.Errorf("node_modules should stop: %+v", r)
	}
}
