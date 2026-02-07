output "instance_name" {
  description = "GCE instance name"
  value       = google_compute_instance.bastion.name
}

output "public_ip" {
  description = "Public IP of the bastion instance"
  value       = google_compute_instance.bastion.network_interface[0].access_config[0].nat_ip
}

output "tailscale_hostname" {
  description = "Tailscale hostname"
  value       = "bastion-mcp"
}
