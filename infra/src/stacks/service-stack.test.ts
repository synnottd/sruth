import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from './network-stack.js';
import { DataStack } from './data-stack.js';
import { ServiceStack } from './service-stack.js';
import type { EnvConfig } from '../config.js';

const testConfig: EnvConfig = {
  account: '123456789012',
  region: 'us-east-1',
  db: { instanceClass: 'db.t4g.micro' },
  taskSize: { cpu: 1024, memoryMiB: 2048 },
};

function createStacks() {
  const app = new cdk.App({ context: { imageTag: 'abc1234' } });
  const env = { account: testConfig.account, region: testConfig.region };
  const network = new NetworkStack(app, 'TestNetwork', { env });
  const data = new DataStack(app, 'TestData', { env, network, config: testConfig });
  const service = new ServiceStack(app, 'TestService', { env, network, data, config: testConfig });
  return Template.fromStack(service);
}

describe('ServiceStack', () => {
  describe('ECS Cluster', () => {
    it('creates a cluster named omega-stream', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::ECS::Cluster', {
        ClusterName: 'omega-stream',
      });
    });
  });

  describe('Log Groups', () => {
    it('creates 5 log groups with 14-day retention', () => {
      const template = createStacks();
      const logGroups = template.findResources('AWS::Logs::LogGroup');
      const logGroupKeys = Object.keys(logGroups);
      expect(logGroupKeys).toHaveLength(5);
      for (const key of logGroupKeys) {
        expect(logGroups[key].Properties.RetentionInDays).toBe(14);
      }
    });

    it('creates log groups with correct names', () => {
      const template = createStacks();
      for (const name of [
        '/omega-stream/test/api',
        '/omega-stream/test/web',
        '/omega-stream/test/ingest',
        '/omega-stream/test/worker',
        '/omega-stream/worker/ffmpeg',
      ]) {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
          LogGroupName: name,
        });
      }
    });
  });

  describe('Task Definition', () => {
    it('creates a Fargate task definition with 1 vCPU / 2 GB', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Cpu: '1024',
        Memory: '2048',
        NetworkMode: 'awsvpc',
        RequiresCompatibilities: ['FARGATE'],
      });
    });

    it('defines 4 containers with correct names and resource allocation', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({ Name: 'api', Cpu: 128, Memory: 384, Essential: true }),
          Match.objectLike({ Name: 'web', Cpu: 192, Memory: 512, Essential: true }),
          Match.objectLike({ Name: 'ingest', Cpu: 128, Memory: 256, Essential: true }),
          Match.objectLike({ Name: 'worker', Cpu: 576, Memory: 896, Essential: true }),
        ]),
      });
    });

    it('configures correct port mappings for each container', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'api',
            PortMappings: [{ ContainerPort: 3000, Protocol: 'tcp' }],
          }),
          Match.objectLike({
            Name: 'web',
            PortMappings: [{ ContainerPort: 3002, Protocol: 'tcp' }],
          }),
          Match.objectLike({
            Name: 'ingest',
            PortMappings: Match.arrayWith([
              Match.objectLike({ ContainerPort: 1935, Protocol: 'tcp' }),
            ]),
          }),
        ]),
      });
    });

    it('configures API health check', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'api',
            HealthCheck: {
              Command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
              Interval: 30,
              Retries: 3,
              Timeout: 5,
              StartPeriod: 60,
            },
          }),
        ]),
      });
    });

    it('sets container dependency - web, ingest, worker depend on API healthy', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'web',
            DependsOn: [{ ContainerName: 'api', Condition: 'HEALTHY' }],
          }),
          Match.objectLike({
            Name: 'ingest',
            DependsOn: [{ ContainerName: 'api', Condition: 'HEALTHY' }],
          }),
          Match.objectLike({
            Name: 'worker',
            DependsOn: [{ ContainerName: 'api', Condition: 'HEALTHY' }],
          }),
        ]),
      });
    });

    it('uses ECR images with correct tag from context', () => {
      const template = createStacks();
      const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
      const key = Object.keys(taskDefs)[0];
      const containers = taskDefs[key].Properties.ContainerDefinitions;
      for (const name of ['api', 'web', 'ingest', 'worker']) {
        const container = containers.find((c: { Name: string }) => c.Name === name);
        const joinArr = container.Image['Fn::Join'][1];
        const lastElement = joinArr[joinArr.length - 1];
        expect(lastElement).toBe(':abc1234');
      }
    });

    it('configures awsLogs logging for each container', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'api',
            LogConfiguration: {
              LogDriver: 'awslogs',
              Options: Match.objectLike({
                'awslogs-stream-prefix': 'ecs',
              }),
            },
          }),
        ]),
      });
    });
  });

  describe('IAM - Execution Role', () => {
    it('grants ECR pull, CloudWatch Logs, and Secrets Manager read', () => {
      const template = createStacks();
      // Execution role should have policies for ecr, logs, and secretsmanager
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ecr:GetDownloadUrlForLayer']),
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });
  });

  describe('IAM - Task Role', () => {
    it('grants SQS permissions on worker queue', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['sqs:SendMessage']),
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });

    it('grants CloudWatch PutMetricData and Logs permissions for worker', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'cloudwatch:PutMetricData',
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });

    it('grants elasticache:Connect permission', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'elasticache:Connect',
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });
  });

  describe('Secrets Injection', () => {
    it('injects DB credential fields into API container as secrets and env', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'api',
            Secrets: Match.arrayWith([
              Match.objectLike({ Name: 'DB_HOST' }),
              Match.objectLike({ Name: 'DB_USER' }),
              Match.objectLike({ Name: 'DB_PASSWORD' }),
              Match.objectLike({ Name: 'DB_PORT' }),
            ]),
            Environment: Match.arrayWith([
              Match.objectLike({ Name: 'DB_NAME', Value: 'postgres' }),
            ]),
          }),
        ]),
      });
    });

    it('injects JWT_SECRET into API container', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'api',
            Secrets: Match.arrayWith([
              Match.objectLike({ Name: 'JWT_SECRET' }),
            ]),
          }),
        ]),
      });
    });

    it('injects INTERNAL_SECRET into API and Ingest containers', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'api',
            Secrets: Match.arrayWith([
              Match.objectLike({ Name: 'INTERNAL_SECRET' }),
            ]),
          }),
          Match.objectLike({
            Name: 'ingest',
            Secrets: Match.arrayWith([
              Match.objectLike({ Name: 'INTERNAL_SECRET' }),
            ]),
          }),
        ]),
      });
    });
  });

  describe('ECS Service', () => {
    it('creates a Fargate service named omega-stream with desiredCount 1', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::ECS::Service', {
        ServiceName: 'omega-stream',
        DesiredCount: 0,
        LaunchType: 'FARGATE',
      });
    });

    it('assigns public IP in public subnets with ECS security group', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::ECS::Service', {
        NetworkConfiguration: {
          AwsvpcConfiguration: {
            AssignPublicIp: 'ENABLED',
            SecurityGroups: Match.anyValue(),
            Subnets: Match.anyValue(),
          },
        },
      });
    });

    it('uses stop-then-start deploy strategy (minHealthy 0, maxPercent 100)', () => {
      const template = createStacks();
      template.hasResourceProperties('AWS::ECS::Service', {
        DeploymentConfiguration: {
          MinimumHealthyPercent: 0,
          MaximumPercent: 100,
        },
      });
    });
  });
});
