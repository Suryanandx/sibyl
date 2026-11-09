/**
 * Identity: users, sign-in, invitations, workspaces with members, and the
 * permission checks in front of every gateway entry point.
 * See docs/plans/v0.4-architecture.md (§3, §4 and the appendix table).
 */
export { IdentityError, IdentityService, INVITE_TTL_MS, SESSION_TTL_MS, type Authenticated, type IdentityChange, type IdentityMode } from "./service.js";
export {
  SESSION_COOKIE,
  authenticateUpgrade,
  createIdentityBridge,
  gateProtectedRoute,
  handleIdentityHttp,
  protectedRoutePermission,
  type IdentityHttpOptions
} from "./http.js";
export { MODEL_SETTING_KEYS, QUIET_DENIALS, permissionForMessage, permissionTable } from "./ws.js";
export { inviteMailer, type InviteMail, type InviteMailer } from "./mail.js";
export { LoginRateLimiter } from "./rate-limit.js";
export { hashPassword, verifyPassword } from "./crypto.js";
export { MfaService, MFA_KV_KEY, type MfaStatus } from "./mfa.js";
export { OrgAdmin, type LicenseInfo, type OrgAdminOptions } from "./org.js";
export { handleOrgAdminHttp, isOrgAdminPath, type OrgAdminHttpOptions } from "./org-http.js";
