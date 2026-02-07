terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project
  region  = var.region
  zone    = var.zone
}

resource "google_compute_firewall" "bastion" {
  name    = "bastion-mcp-allow"
  network = "default"

  allow {
    protocol = "udp"
    ports    = ["41641"]
  }

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = ["100.64.0.0/10"]
  target_tags   = ["bastion-mcp"]
}

resource "google_compute_instance" "bastion" {
  name         = "bastion-mcp-server"
  machine_type = var.machine_type
  zone         = var.zone

  tags = ["bastion-mcp"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = 20
    }
  }

  network_interface {
    network = "default"
    access_config {} # Ephemeral public IP
  }

  metadata_startup_script = <<-EOF
    #!/bin/bash
    set -euo pipefail

    curl -fsSL https://tailscale.com/install.sh | sh
    tailscale up --authkey="${var.tailscale_auth_key}" --hostname=bastion-mcp

    curl -fsSL https://get.docker.com | sh

    docker run -d \
      --name bastion-mcp \
      --restart unless-stopped \
      --network host \
      -e TRANSPORT=http \
      -e BASTION_API_KEY="${var.bastion_api_key}" \
      ${var.bastion_image}
  EOF

  labels = {
    project = "claude-playground"
  }
}
