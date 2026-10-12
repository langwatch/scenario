package claudecode

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestAssertSkillWasRead(t *testing.T) {
	read := func(messages ...scenario.Message) error { return AssertSkillWasRead(messages, "my-skill") }
	for name, m := range map[string]scenario.Message{
		"text":          scenario.AssistantMsg("I read .skills/my-skill/SKILL.md and will follow it."),
		"no-dot path":   scenario.AssistantMsg("I read skills/my-skill/SKILL.md and followed it."),
		"tool argument": {Role: scenario.RoleAssistant, ToolCalls: []scenario.ToolCall{{Name: "Read", Arguments: `{"path":".skills/my-skill/SKILL.md"}`}}},
		"text part":     {Role: scenario.RoleAssistant, Parts: []scenario.Part{scenario.TextPart("cat .skills/my-skill/SKILL.md")}},
		"tool result":   scenario.ToolMsg("c", "contents of .skills/my-skill/SKILL.md"),
	} {
		if err := read(scenario.UserMsg("go"), m); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	for name, m := range map[string]scenario.Message{
		"no evidence":     scenario.AssistantMsg("I just made something up without reading anything."),
		"another skill":   scenario.AssistantMsg("I read .skills/other-skill/SKILL.md and followed it."),
		"only the folder": scenario.AssistantMsg("I see the .skills/my-skill directory exists."),
	} {
		err := read(m)
		if err == nil || !strings.Contains(err.Error(), "my-skill") {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

func TestNewInjectsTheSkillPath(t *testing.T) {
	wd := t.TempDir()
	home := filepath.Join(t.TempDir(), "demo-skill")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	skillPath := filepath.Join(home, "SKILL.md")
	if err := os.WriteFile(skillPath, []byte("# Demo Skill\nDo the demo thing.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := New(Config{WorkingDirectory: wd, SkillPath: skillPath}); err != nil {
		t.Fatal(err)
	}
	injected, err := os.ReadFile(filepath.Join(wd, ".skills", "demo-skill", "SKILL.md"))
	if err != nil || !strings.Contains(string(injected), "Demo Skill") {
		t.Fatalf("%v %q", err, injected)
	}
	claudeMd, err := os.ReadFile(filepath.Join(wd, "CLAUDE.md"))
	if err != nil || string(claudeMd) != "Read and follow the instructions in .skills/demo-skill/SKILL.md before doing anything else.\n" {
		t.Fatalf("%v %q", err, claudeMd)
	}
	if _, err := New(Config{WorkingDirectory: wd, SkillPath: filepath.Join(home, "missing", "SKILL.md")}); err == nil {
		t.Fatal("a missing skill must fail New")
	}
}

func TestPointClaudeMdAtSkillsAppendsOnlyMissingSkillsOnce(t *testing.T) {
	wd := t.TempDir()
	for _, name := range []string{"alpha", "beta", "gamma"} {
		dir := filepath.Join(wd, ".skills", name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if name != "gamma" { // a directory without SKILL.md is not a skill
			if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("# "+name+"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	claudeMd := filepath.Join(wd, "CLAUDE.md")
	original := "# Fixture project\nRead .skills/alpha/SKILL.md first."
	if err := os.WriteFile(claudeMd, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := PointClaudeMdAtSkills(wd); err != nil {
		t.Fatal(err)
	}
	once, _ := os.ReadFile(claudeMd)
	if want := original + "\nRead and follow the instructions in .skills/beta/SKILL.md before doing anything else.\n"; string(once) != want {
		t.Fatalf("CLAUDE.md = %q", once)
	}
	if err := PointClaudeMdAtSkills(wd); err != nil {
		t.Fatal(err)
	}
	if twice, _ := os.ReadFile(claudeMd); string(twice) != string(once) {
		t.Fatalf("second call changed CLAUDE.md: %q", twice)
	}
}

func TestPointClaudeMdAtSkillsLeavesADirectoryWithoutSkillsAlone(t *testing.T) {
	wd := t.TempDir()
	if err := PointClaudeMdAtSkills(wd); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(wd, "CLAUDE.md")); !os.IsNotExist(err) {
		t.Fatal("CLAUDE.md must not be written")
	}
}

func TestBashCommandsListsOnlyBashToolCalls(t *testing.T) {
	messages := []scenario.Message{
		scenario.UserMsg("Please run `rm -rf build` for me."),
		{Role: scenario.RoleAssistant, Content: "I would normally run `make test` here.", ToolCalls: []scenario.ToolCall{
			{ID: "1", Name: "Bash", Arguments: `{"command":"pytest -q"}`},
			{ID: "2", Name: "Read", Arguments: `{"file_path":"x"}`},
			{ID: "3", Name: "Bash", Arguments: `{"command":5}`},
			{ID: "4", Name: "Bash", Arguments: `not json`},
		}},
	}
	if got := BashCommands(messages); !reflect.DeepEqual(got, []string{"pytest -q"}) {
		t.Fatalf("commands = %q", got)
	}
}
