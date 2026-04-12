import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elasticache from '@aws-cdk/aws-elasticache-alpha';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { NetworkStack } from './network-stack.js';
import type { EnvConfig } from '../config.js';

export interface DataStackProps extends cdk.StackProps {
  network: NetworkStack;
  config: EnvConfig;
}

export class DataStack extends cdk.Stack {
  public readonly workerQueue: sqs.Queue;
  public readonly workerDlq: sqs.Queue;
  public readonly jwtSecret: secretsmanager.Secret;
  public readonly internalSecret: secretsmanager.Secret;
  public readonly ecrRepos: Record<string, ecr.Repository>;
  public readonly db: rds.DatabaseInstance;
  public readonly dbSecret: secretsmanager.ISecret;
  public readonly cache: elasticache.ServerlessCache;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { network, config } = props;

    // --- Secrets ---
    this.jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
      secretName: 'omega-stream/jwt-secret',
      generateSecretString: { excludePunctuation: true, passwordLength: 64 },
    });

    this.internalSecret = new secretsmanager.Secret(this, 'InternalSecret', {
      secretName: 'omega-stream/internal-secret',
      generateSecretString: { excludePunctuation: true, passwordLength: 64 },
    });

    // --- SQS ---
    this.workerDlq = new sqs.Queue(this, 'WorkerDlq', {
      queueName: 'omega-stream-worker-dlq.fifo',
      fifo: true,
    });

    this.workerQueue = new sqs.Queue(this, 'WorkerQueue', {
      queueName: 'omega-stream-worker.fifo',
      fifo: true,
      visibilityTimeout: cdk.Duration.seconds(30),
      deadLetterQueue: {
        queue: this.workerDlq,
        maxReceiveCount: 3,
      },
    });

    // --- ECR ---
    const serviceNames = ['api', 'web', 'ingest', 'worker'] as const;
    this.ecrRepos = {};
    for (const name of serviceNames) {
      this.ecrRepos[name] = new ecr.Repository(this, `Ecr${name}`, {
        repositoryName: `omega-stream/${name}`,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
    }

    // --- RDS PostgreSQL (test mode — replaces Aurora Serverless v2) ---
    this.db = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: new ec2.InstanceType(config.db.instanceClass.replace('db.', '')),
      vpc: network.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [network.auroraSg],
      multiAz: false,
      allocatedStorage: 20,
      backupRetention: cdk.Duration.days(0),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      credentials: rds.Credentials.fromGeneratedSecret('postgres', {
        secretName: 'omega-stream/db-credentials',
      }),
    });

    this.dbSecret = this.db.secret!;

    // --- ElastiCache Serverless (Valkey) ---
    this.cache = new elasticache.ServerlessCache(this, 'Redis', {
      engine: elasticache.CacheEngine.VALKEY_LATEST,
      serverlessCacheName: 'omega-stream',
      vpc: network.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [network.redisSg],
    });
  }
}
