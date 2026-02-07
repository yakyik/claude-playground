terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
}

resource "aws_security_group" "bastion" {
  name_prefix = "bastion-mcp-"
  description = "Security group for bastion MCP server"

  # Allow Tailscale (UDP 41641) from anywhere for mesh connectivity
  ingress {
    from_port   = 41641
    to_port     = 41641
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Tailscale WireGuard"
  }

  # Allow SSH from Tailscale only (will be restricted by Tailscale ACLs)
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["100.64.0.0/10"]
    description = "SSH via Tailscale"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "All outbound"
  }

  tags = {
    Name    = "bastion-mcp-server"
    Project = "claude-playground"
  }
}

resource "aws_instance" "bastion" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  vpc_security_group_ids = [aws_security_group.bastion.id]

  user_data = <<-EOF
    #!/bin/bash
    set -euo pipefail

    # Install Tailscale
    curl -fsSL https://tailscale.com/install.sh | sh
    tailscale up --authkey="${var.tailscale_auth_key}" --hostname=bastion-mcp

    # Install Docker
    curl -fsSL https://get.docker.com | sh

    # Pull and run the bastion MCP server
    docker run -d \
      --name bastion-mcp \
      --restart unless-stopped \
      --network host \
      -e TRANSPORT=http \
      -e BASTION_API_KEY="${var.bastion_api_key}" \
      ${var.bastion_image}
  EOF

  tags = {
    Name    = "bastion-mcp-server"
    Project = "claude-playground"
  }
}
