package main

import (
	"os"

	"github.com/jo824/claude-playground/internal/cmd"

	// Register providers via init()
	_ "github.com/jo824/claude-playground/internal/provider/docker"
	_ "github.com/jo824/claude-playground/internal/provider/lima"
)

func main() {
	if err := cmd.Execute(); err != nil {
		os.Exit(1)
	}
}
