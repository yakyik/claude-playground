package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/spf13/cobra"
)

var connectCmd = &cobra.Command{
	Use:   "connect",
	Short: "Connect to the playground instance via SSH",
	Long:  "Opens an SSH session to the running playground infrastructure.",
	RunE: func(cmd *cobra.Command, _ []string) error {
		cfg, err := loadCfg()
		if err != nil {
			return err
		}

		p, err := getProvider(cfg)
		if err != nil {
			return err
		}

		sshCfg, err := p.SSHConfig(cmd.Context())
		if err != nil {
			return fmt.Errorf("cannot connect: %w", err)
		}

		fmt.Fprintf(cmd.OutOrStdout(), "Connecting to playground...\n")

		// Write temporary SSH config and exec into SSH
		sshCmd := exec.CommandContext(cmd.Context(), "ssh", "-F", "/dev/stdin", "playground")
		sshCmd.Stdin = strings.NewReader(sshCfg)
		sshCmd.Stdout = os.Stdout
		sshCmd.Stderr = os.Stderr

		return sshCmd.Run()
	},
}
