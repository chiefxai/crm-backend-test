// AWS Cognito authentication provider.
// Required: COGNITO_USER_POOL_ID, COGNITO_REGION, COGNITO_CLIENT_ID.
//
// Cognito is the identity source; CRM MySQL org_members remains the source of
// truth for organization membership. Cognito groups mirror the CRM role so
// tokens also carry a standard `cognito:groups` claim.
//
// Required IAM permissions for provisioning:
//   cognito-idp:ListUsers
//   cognito-idp:AdminCreateUser
//   cognito-idp:AdminSetUserPassword
//   cognito-idp:AdminGetUser
//   cognito-idp:AdminAddUserToGroup
//   cognito-idp:AdminListGroupsForUser
//   cognito-idp:AdminRemoveUserFromGroup
//   cognito-idp:AdminDeleteUser
const { CognitoJwtVerifier } = require('aws-jwt-verify');
const {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminGetUserCommand,
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminDeleteUserCommand,
  CreateGroupCommand,
  UsernameExistsException,
  GroupExistsException,
} = require('@aws-sdk/client-cognito-identity-provider');
const crypto = require('crypto');
const { getLogger } = require('../../observability/logger');
const log = getLogger('auth.providers.cognito');

const REGION = process.env.COGNITO_REGION;
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;

const COGNITO_ROLES = Object.freeze({
  SUPER_ADMIN: 'SuperAdmin',
  ORGANIZATION_ADMIN: 'OrganizationAdmin',
  TEAM_MEMBER: 'TeamMember',
});
const ROLE_GROUPS = Object.freeze(Object.values(COGNITO_ROLES));
const ROLE_SET = new Set(ROLE_GROUPS);

let idpClient;
function getIdpClient() {
  if (!idpClient) {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    idpClient = new CognitoIdentityProviderClient({
      region: REGION,
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    });
  }
  return idpClient;
}

let accessVerifier;
let idVerifier;
function getAccessVerifier() {
  if (!accessVerifier) accessVerifier = CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, tokenUse: 'access', clientId: CLIENT_ID });
  return accessVerifier;
}
function getIdVerifier() {
  if (!idVerifier) idVerifier = CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, tokenUse: 'id', clientId: CLIENT_ID });
  return idVerifier;
}

async function verifyToken(token) {
  if (!token) throw new Error('Missing Cognito token');
  if (!REGION || !USER_POOL_ID || !CLIENT_ID) throw new Error('Cognito authentication is not configured');
  try {
    return await getAccessVerifier().verify(token);
  } catch (accessErr) {
    try { return await getIdVerifier().verify(token); }
    catch { throw accessErr; }
  }
}

// Access tokens are the correct authorization credential for CRM APIs, but
// Cognito access-token claims do not normally contain the user's email.
// Resolve the email from Cognito itself when an authenticated endpoint needs
// identity-level authorization (for example the platform-admin allowlist).
async function resolveIdentity(token, payload = {}) {
  if (payload?.email || payload?.preferred_username) return payload;
  if (!token || !REGION) return payload;

  try {
    const users = await getIdpClient().send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Filter: `sub = "${String(payload.sub).replace(/"/g, '\\"')}"`,
      Limit: 1,
    }));
    const user = users?.Users?.[0];
    const email = getAttribute(user, 'email');
    const name = getAttribute(user, 'name');
    return {
      ...payload,
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
    };
  } catch (err) {
    log.warn('⚠️ Cognito identity enrichment failed', { error: err.message });
    return payload;
  }
}

function decodeToken(token) {
  try { return require('jsonwebtoken').decode(token); } catch { return null; }
}

function normalizeRole(role) {
  const value = String(role || COGNITO_ROLES.TEAM_MEMBER).trim();
  if (!ROLE_SET.has(value)) throw new Error(`Invalid Cognito role "${value}"`);
  return value;
}

function generateCompliantTemporaryPassword(length = 16) {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const symbols = '!@#$%^&*_-+=';
  const all = upper + lower + digits + symbols;
  const pick = (chars) => chars[crypto.randomInt(chars.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  for (let i = chars.length; i < length; i++) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

async function ensureRoleGroups() {
  if (!REGION || !USER_POOL_ID) throw new Error('Cognito authentication is not configured');
  const client = getIdpClient();
  for (const groupName of ROLE_GROUPS) {
    try {
      await client.send(new CreateGroupCommand({
        UserPoolId: USER_POOL_ID,
        GroupName: groupName,
        Description: `CRM role: ${groupName}`,
      }));
    } catch (err) {
      if (!(err instanceof GroupExistsException) && err.name !== 'GroupExistsException') {
        throw new Error(`Cognito role group "${groupName}" could not be ensured: ${err.message}`);
      }
    }
  }
}

async function getUser(emailOrUsername) {
  try {
    return await getIdpClient().send(new AdminGetUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: emailOrUsername,
    }));
  } catch (err) {
    if (err.name === 'UserNotFoundException') return null;
    throw err;
  }
}

function getAttribute(user, name) {
  return user?.UserAttributes?.find((a) => a.Name === name)?.Value || null;
}

async function syncUserRole(username, role) {
  const targetRole = normalizeRole(role);
  const client = getIdpClient();
  await ensureRoleGroups();
  const current = await client.send(new AdminListGroupsForUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
  }));
  const currentGroups = (current.Groups || []).map((g) => g.GroupName).filter(Boolean);
  for (const groupName of ROLE_GROUPS) {
    if (groupName !== targetRole && currentGroups.includes(groupName)) {
      await client.send(new AdminRemoveUserFromGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        GroupName: groupName,
      }));
    }
  }
  if (!currentGroups.includes(targetRole)) {
    await client.send(new AdminAddUserToGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      GroupName: targetRole,
    }));
  }
  return targetRole;
}

async function provisionUser(email, password, name = '', role = COGNITO_ROLES.TEAM_MEMBER) {
  if (!REGION || !USER_POOL_ID) throw new Error('Cognito authentication is not configured');
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) throw new Error('Email is required for Cognito provisioning');
  const targetRole = normalizeRole(role);
  const client = getIdpClient();
  await ensureRoleGroups();
  let user;
  try {
    const createRes = await client.send(new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: normalizedEmail,
      UserAttributes: [
        { Name: 'email', Value: normalizedEmail },
        { Name: 'email_verified', Value: 'true' },
        ...(name ? [{ Name: 'name', Value: name }] : []),
      ],
      MessageAction: 'SUPPRESS',
    }));
    user = createRes.User;
  } catch (err) {
    if (err instanceof UsernameExistsException || err.name === 'UsernameExistsException') {
      user = await getUser(normalizedEmail);
    } else {
      throw new Error(`Cognito user creation failed: ${err.message}`);
    }
  }
  if (!user?.Username) throw new Error('Cognito user could not be resolved after provisioning');
  const username = user.Username;
  if (password) {
    try {
      await client.send(new AdminSetUserPasswordCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        Password: password,
        Permanent: false,
      }));
    } catch (err) {
      throw new Error(`Cognito set-password failed: ${err.message}`);
    }
  }
  await syncUserRole(username, targetRole);
  const resolved = await getUser(username);
  const userId = getAttribute(resolved, 'sub') || getAttribute(user, 'sub');
  if (!userId) throw new Error('Cognito user was created but its immutable sub was not returned');
  log.info('✅ Cognito user provisioned', { userId, email: normalizedEmail, role: targetRole });
  return userId;
}

async function deleteUser(username) {
  if (!REGION || !USER_POOL_ID) throw new Error('Cognito authentication is not configured');
  try {
    await getIdpClient().send(new AdminDeleteUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
    }));
    return true;
  } catch (err) {
    if (err.name === 'UserNotFoundException') return true;
    throw new Error(`Cognito user deletion failed: ${err.message}`);
  }
}

module.exports = {
  verifyToken,
  decodeToken,
  provisionUser,
  syncUserRole,
  deleteUser,
  ensureRoleGroups,
  generateCompliantTemporaryPassword,
  COGNITO_ROLES,
};