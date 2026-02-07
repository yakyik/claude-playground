output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.bastion.id
}

output "public_ip" {
  description = "Public IP of the bastion instance"
  value       = aws_instance.bastion.public_ip
}

output "tailscale_hostname" {
  description = "Tailscale hostname"
  value       = "bastion-mcp"
}
