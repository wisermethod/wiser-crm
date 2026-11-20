// The binding and install-input contract shared by the format 3 builder and signer.
export const CRM = 'wiser-crm';
export const INTAKE = 'wiser-crm-intake';
export const NOTICE = Object.freeze({ name: 'NOTICE', destination_var: 'NOTICE_TO', sender_var: 'NOTICE_FROM' });

export const APPS = {
  [CRM]: {
    database: 'crm',
    d1: [{ name: 'DB', database: 'crm' }, { name: 'INTAKE_DB', database: 'intake' }],
    mail: [],
    required: ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'AGENT_CLIENT_ID', 'WISER_INSTANCE', 'WISER_READ_ONLY'],
    optional: [],
    baseline: '0001_baseline.sql',
  },
  [INTAKE]: {
    database: 'intake',
    d1: [{ name: 'INTAKE_DB', database: 'intake' }],
    mail: [NOTICE],
    required: ['INTAKE_ORIGIN', 'INTAKE_RETURN_URL', NOTICE.destination_var, NOTICE.sender_var],
    optional: ['INTAKE_MAX_PER_ADDRESS_PER_DAY', 'INTAKE_MAX_PER_HOUR', 'CRM_URL'],
    baseline: '0001_intake.sql',
  },
};

export const MIGRATION_TABLE = 'd1_migrations';
export const MIGRATION_NAME = /^\d+_[A-Za-z0-9_-]+\.sql$/;
export const INTAKE_INPUT = /^intake\/[a-z][a-z0-9-]*\.ts$/;

export function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareMigrations(left, right) {
  const a = BigInt(left.split('_', 1)[0]), b = BigInt(right.split('_', 1)[0]);
  return a < b ? -1 : a > b ? 1 : compareNames(left, right);
}

export function sameList(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && expected.every((value, index) => value === actual[index]);
}

export function checkIntakeInputs(inputs) {
  if (!Array.isArray(inputs) || !inputs.includes('intake/worker.ts')
    || !inputs.every(name => typeof name === 'string' && INTAKE_INPUT.test(name))
    || !inputs.every((name, index) => index === 0 || inputs[index - 1] < name)) {
    throw new Error('release intake bundle inputs must be unique, sorted intake sources including intake/worker.ts');
  }
}
