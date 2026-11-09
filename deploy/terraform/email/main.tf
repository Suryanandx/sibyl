# Sending email as opensibyl.world through Amazon SES (eu-central-1).
#
# Creates the SES domain identity with DKIM signing, a custom MAIL FROM domain
# (mail.opensibyl.world) so SPF aligns, and a DMARC policy, all published in
# Hostinger DNS. Nothing here sends mail by itself: the app sends through SES
# SMTP once it is deployed (deploy/terraform/app). The SES account is already
# out of the sandbox.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws       = { source = "hashicorp/aws", version = "~> 6.0" }
    hostinger = { source = "hostinger/hostinger", version = "~> 0.1.23" }
  }
  backend "s3" {
    key          = "email/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "eu-central-1"
  default_tags { tags = { Project = "sibyl", ManagedBy = "terraform", Stack = "email" } }
}

provider "hostinger" {
  api_token = var.hostinger_api_token
}

variable "domain" {
  type    = string
  default = "opensibyl.world"
}

variable "hostinger_api_token" {
  description = "Hostinger API token (DNS). Pass with TF_VAR_hostinger_api_token; never commit it."
  type        = string
  sensitive   = true
}

locals {
  mail_from = "mail.${var.domain}"
}

# Bounces and complaints are tracked per configuration set; the app sends with it.
resource "aws_sesv2_configuration_set" "app" {
  configuration_set_name = "sibyl-app"
  reputation_options { reputation_metrics_enabled = true }
  sending_options { sending_enabled = true }
  suppression_options { suppressed_reasons = ["BOUNCE", "COMPLAINT"] }
  delivery_options { tls_policy = "REQUIRE" }
}

resource "aws_sesv2_email_identity" "domain" {
  email_identity         = var.domain
  configuration_set_name = aws_sesv2_configuration_set.app.configuration_set_name
  dkim_signing_attributes { next_signing_key_length = "RSA_2048_BIT" }
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity         = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain       = local.mail_from
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

# Easy DKIM: three CNAMEs.
resource "hostinger_dns_record" "dkim" {
  count = 3
  zone  = var.domain
  name  = "${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}._domainkey"
  type  = "CNAME"
  value = "${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"
  ttl   = 3600
}

# MAIL FROM: bounces go to SES, and SPF passes for mail.opensibyl.world.
resource "hostinger_dns_record" "mail_from_mx" {
  zone  = var.domain
  name  = "mail"
  type  = "MX"
  value = "10 feedback-smtp.eu-central-1.amazonses.com"
  ttl   = 3600
}

resource "hostinger_dns_record" "mail_from_spf" {
  zone  = var.domain
  name  = "mail"
  type  = "TXT"
  value = "v=spf1 include:amazonses.com -all"
  ttl   = 3600
}

# The domain itself sends nothing except through SES.
resource "hostinger_dns_record" "spf" {
  zone  = var.domain
  name  = "@"
  type  = "TXT"
  value = "v=spf1 include:amazonses.com -all"
  ttl   = 3600
}

resource "hostinger_dns_record" "dmarc" {
  zone  = var.domain
  name  = "_dmarc"
  type  = "TXT"
  value = "v=DMARC1; p=quarantine; adkim=s; aspf=r; pct=100"
  ttl   = 3600
}

output "identity" {
  value = aws_sesv2_email_identity.domain.email_identity
}

output "configuration_set" {
  value = aws_sesv2_configuration_set.app.configuration_set_name
}

output "smtp_host" {
  value = "email-smtp.eu-central-1.amazonaws.com"
}
