variable "region" {
  description = "Region for the bucket and the deploy role."
  type        = string
  default     = "eu-central-1"
}

variable "primary_domain" {
  description = "The site's address. Everything else redirects here."
  type        = string
  default     = "opensibyl.world"
}

variable "redirect_domains" {
  description = "Other zones at Hostinger whose apex and www redirect to the primary domain."
  type        = list(string)
  default     = ["opensibyl.pro"]
}

variable "github_repo" {
  description = "owner/name of the repository whose Actions may publish the site."
  type        = string
  default     = "Suryanandx/sibyl"
}

variable "hostinger_api_token" {
  description = "Hostinger API token (DNS). Pass with TF_VAR_hostinger_api_token; never commit it."
  type        = string
  sensitive   = true
}
