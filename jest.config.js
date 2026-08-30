/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\.tsx?$': ['ts-jest', { tsconfig: { noUnusedLocals: false, noUnusedParameters: false } }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.generated.ts'],
  coverageThreshold: {
    global: { branches: 70, functions: 80, lines: 80, statements: 80 },
  },
  // CDK synth in infra tests is slow; 30s keeps CI honest without flaking.
  testTimeout: 30000,
};
