import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { NetworkStack } from './network-stack.js';
import type { DataStack } from './data-stack.js';
import type { EnvConfig } from '../config.js';

export interface ServiceStackProps extends cdk.StackProps {
  network: NetworkStack;
  data: DataStack;
  config: EnvConfig;
}

export class ServiceStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ServiceStackProps) {
    super(scope, id, props);

    const { network, data, config } = props;
    const imageTag = this.node.tryGetContext('imageTag') ?? 'latest';

    // --- ECS Cluster ---
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: 'omega-stream',
      vpc: network.vpc,
    });

    // --- Log Groups ---
    const logGroupApi = new logs.LogGroup(this, 'LogGroupApi', {
      logGroupName: '/omega-stream/test/api',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const logGroupWeb = new logs.LogGroup(this, 'LogGroupWeb', {
      logGroupName: '/omega-stream/test/web',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const logGroupIngest = new logs.LogGroup(this, 'LogGroupIngest', {
      logGroupName: '/omega-stream/test/ingest',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const logGroupWorker = new logs.LogGroup(this, 'LogGroupWorker', {
      logGroupName: '/omega-stream/test/worker',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const logGroupFfmpeg = new logs.LogGroup(this, 'LogGroupFfmpeg', {
      logGroupName: '/omega-stream/worker/ffmpeg',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Task Definition ---
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: config.taskSize.cpu,
      memoryLimitMiB: config.taskSize.memoryMiB,
    });

    // --- Container: API ---
    const apiContainer = taskDef.addContainer('api', {
      image: ecs.ContainerImage.fromEcrRepository(data.ecrRepos['api'], imageTag),
      cpu: 128,
      memoryLimitMiB: 384,
      essential: true,
      portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        retries: 3,
        timeout: cdk.Duration.seconds(5),
        startPeriod: cdk.Duration.seconds(60),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: logGroupApi,
        streamPrefix: 'ecs',
      }),
      environment: {
        DB_NAME: 'postgres',
      },
      secrets: {
        DB_HOST: ecs.Secret.fromSecretsManager(data.dbSecret, 'host'),
        DB_USER: ecs.Secret.fromSecretsManager(data.dbSecret, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(data.dbSecret, 'password'),
        DB_PORT: ecs.Secret.fromSecretsManager(data.dbSecret, 'port'),
        JWT_SECRET: ecs.Secret.fromSecretsManager(data.jwtSecret),
        INTERNAL_SECRET: ecs.Secret.fromSecretsManager(data.internalSecret),
      },
    });

    // --- Container: Web ---
    taskDef.addContainer('web', {
      image: ecs.ContainerImage.fromEcrRepository(data.ecrRepos['web'], imageTag),
      cpu: 192,
      memoryLimitMiB: 512,
      essential: true,
      portMappings: [{ containerPort: 3002, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({
        logGroup: logGroupWeb,
        streamPrefix: 'ecs',
      }),
    }).addContainerDependencies({ container: apiContainer, condition: ecs.ContainerDependencyCondition.HEALTHY });

    // --- Container: Ingest ---
    taskDef.addContainer('ingest', {
      image: ecs.ContainerImage.fromEcrRepository(data.ecrRepos['ingest'], imageTag),
      cpu: 128,
      memoryLimitMiB: 256,
      essential: true,
      portMappings: [
        { containerPort: 1935, protocol: ecs.Protocol.TCP },
        { containerPort: 8080, protocol: ecs.Protocol.TCP },
      ],
      logging: ecs.LogDrivers.awsLogs({
        logGroup: logGroupIngest,
        streamPrefix: 'ecs',
      }),
      secrets: {
        INTERNAL_SECRET: ecs.Secret.fromSecretsManager(data.internalSecret),
      },
    }).addContainerDependencies({ container: apiContainer, condition: ecs.ContainerDependencyCondition.HEALTHY });

    // --- Container: Worker ---
    taskDef.addContainer('worker', {
      image: ecs.ContainerImage.fromEcrRepository(data.ecrRepos['worker'], imageTag),
      cpu: 576,
      memoryLimitMiB: 896,
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: logGroupWorker,
        streamPrefix: 'ecs',
      }),
    }).addContainerDependencies({ container: apiContainer, condition: ecs.ContainerDependencyCondition.HEALTHY });

    // --- IAM: Task Role grants ---
    // SQS permissions for API (send) and Worker (receive/delete)
    data.workerQueue.grantSendMessages(taskDef.taskRole);
    data.workerQueue.grantConsumeMessages(taskDef.taskRole);
    data.workerDlq.grantConsumeMessages(taskDef.taskRole);

    // ElastiCache Connect (for IAM auth)
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['elasticache:Connect'],
      resources: [data.cache.serverlessCacheArn],
    }));

    // CloudWatch Logs for FFmpeg output
    logGroupFfmpeg.grantWrite(taskDef.taskRole);

    // CloudWatch PutMetricData for worker metrics
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'cloudwatch:namespace': 'OmegaStream/Worker' },
      },
    }));

    // --- ECS Service ---
    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: 'omega-stream',
      cluster: this.cluster,
      taskDefinition: taskDef,
      desiredCount: 0,
      assignPublicIp: true,
      vpcSubnets: { subnetType: cdk.aws_ec2.SubnetType.PUBLIC },
      securityGroups: [network.ecsSg],
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });
  }
}
