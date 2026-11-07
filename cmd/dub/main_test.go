package main

import "testing"

func TestParseRemote(t *testing.T) {
	for in, want := range map[string]string{
		"git@github.com:deeptreecorp/missive.git": "deeptreecorp/missive",
		"https://github.com/o/r":                  "o/r",
		"https://github.com/o/r.git":              "o/r",
		"ssh://git@github.com/o/r.git":            "o/r",
	} {
		got, err := parseRemote(in)
		if err != nil || got != want {
			t.Errorf("%s: %q %v", in, got, err)
		}
	}
	if _, err := parseRemote("nonsense"); err == nil {
		t.Error("want error")
	}
}
