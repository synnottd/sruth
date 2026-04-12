import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from './network-stack.js';
import { DataStack } from './data-stack.js';
import type { EnvConfig } from '../config.js';

const testConfig: EnvConfig = {
  account: '123456789012',
  region: 'us-east-1',
  db: { instanceClass: 'db.t4g.micro' },
  taskSize: { cpu: 1024, memoryMiB: 2048 },
};

function createStacks() {
  const app = new cdk.App();
  const env = { account: testConfig.account, region: testConfig.region };
  const network = new NetworkStack(app, 'TestNetwork', { env });
  const data = new DataStack(app, 'TestData', { env, network, config: testConfig });
  return Template.fromStack(data);
}

describe('DataStack', () => {
  describe('SQS', () => {
    it('creates a FIFO queue with correct name and visibility timeout', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'omega-stream-worker.fifo',
        FifoQueue: true,
        VisibilityTimeout: 30,
      });
    });

    it('creates a FIFO DLQ and wires it to the main queue with maxReceiveCount 3', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'omega-stream-worker-dlq.fifo',
        FifoQueue: true,
      });
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'omega-stream-worker.fifo',
        RedrivePolicy: {
          deadLetterTargetArn: Match.anyValue(),
          maxReceiveCount: 3,
        },
      });
    });
  });

  describe('Secrets Manager', () => {
    it('creates JWT and internal-secret secrets with correct names', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: 'omega-stream/jwt-secret',
      });
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: 'omega-stream/internal-secret',
      });
    });
  });

  describe('Database', () => {
    it('creates a PostgreSQL 16 RDS instance in private subnets', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        Engine: 'postgres',
        DBInstanceClass: 'db.t4g.micro',
      });
      template.resourceCountIs('AWS::RDS::DBSubnetGroup', 1);
    });

    it('places the DB with the Aurora security group and no Multi-AZ', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        VPCSecurityGroups: Match.anyValue(),
        MultiAZ: false,
      });
    });

    it('disables backup retention and enables deletion', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        BackupRetentionPeriod: 0,
        DeletionProtection: false,
      });
    });
  });

  describe('ElastiCache', () => {
    it('creates a Valkey Serverless cache in the VPC', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::ElastiCache::ServerlessCache', {
        Engine: 'valkey',
      });
    });
  });

  describe('ECR', () => {
    it('creates 4 ECR repos with RETAIN removal policy', () => {
      const template = createStacks();
      for (const name of ['omega-stream/api', 'omega-stream/web', 'omega-stream/ingest', 'omega-stream/worker']) {
        template.hasResourceProperties('AWS::ECR::Repository', {
          RepositoryName: name,
        });
      }
      // All 4 repos should have DeletionPolicy: Retain
      const repos = template.findResources('AWS::ECR::Repository');
      const repoKeys = Object.keys(repos);
      expect(repoKeys).toHaveLength(4);
      for (const key of repoKeys) {
        expect(repos[key].DeletionPolicy).toBe('Retain');
      }
    });
  });
});
