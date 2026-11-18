package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProjectFolderPickerScope(t *testing.T) {
	home := t.TempDir()
	outside := t.TempDir()
	for _, name := range []string{"Projects/demo", "Documents", ".ssh"} {
		if err := os.MkdirAll(filepath.Join(home, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(filepath.Join(home, "private-file.txt"), []byte("must not list"), 0600)
	os.Symlink(outside, filepath.Join(home, "escape"))
	list, err := listProjectFolders(home, "")
	if err != nil {
		t.Fatal(err)
	}
	if list.Parent != "" || len(list.Folders) != 2 || list.Folders[0].Name != "Documents" {
		t.Fatal("unexpected root listing", list)
	}
	child, err := listProjectFolders(home, "~/Projects/demo")
	if err != nil || child.Parent != filepath.Join(home, "Projects") {
		t.Fatal("nested folder unavailable", err)
	}
	for _, path := range []string{outside, filepath.Join(home, ".."), filepath.Join(home, "escape"), filepath.Join(home, "private-file.txt")} {
		if _, err := listProjectFolders(home, path); err == nil {
			t.Fatal("scope escape or file accepted", path)
		}
	}
}

func TestCreateProjectFolderIsScopedAndDoesNotOverwrite(t *testing.T) {
	home, outside := t.TempDir(), t.TempDir()
	parent := filepath.Join(home, "Projects")
	if err := os.Mkdir(parent, 0755); err != nil {
		t.Fatal(err)
	}
	newFolder, err := createProjectFolder(home, parent, "Example project")
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(newFolder.Path); err != nil || !info.IsDir() {
		t.Fatalf("expected a new directory, got %v (%v)", info, err)
	}
	if _, err := createProjectFolder(home, parent, "Example project"); !os.IsExist(err) {
		t.Fatalf("duplicate creation should fail, got %v", err)
	}
	if _, err := createProjectFolder(home, outside, "outside"); err == nil {
		t.Fatal("accepted a parent outside the account home")
	}
	link := filepath.Join(home, "outside")
	if err := os.Symlink(outside, link); err == nil {
		if _, err := createProjectFolder(home, link, "outside"); err == nil {
			t.Fatal("followed a symbolic link outside the account home")
		}
	}
}
