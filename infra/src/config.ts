export interface EnvConfig {
  account: string;
  region: string;
  db: { instanceClass: string };
  taskSize: { cpu: number; memoryMiB: number };
}

export const testConfig: EnvConfig = {
  account: process.env.CDK_DEFAULT_ACCOUNT!,
  region: 'us-east-1',
  db: { instanceClass: 'db.t4g.micro' },
  taskSize: { cpu: 1024, memoryMiB: 2048 },
};
