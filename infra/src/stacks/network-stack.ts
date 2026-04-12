import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly ecsSg: ec2.SecurityGroup;
  public readonly auroraSg: ec2.SecurityGroup;
  public readonly redisSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    this.ecsSg = new ec2.SecurityGroup(this, 'EcsSg', {
      vpc: this.vpc,
      description: 'ECS tasks - Web (3002) + RTMP (1935) from internet',
    });
    this.ecsSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3002), 'Web UI');
    this.ecsSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(1935), 'RTMP ingest');

    this.auroraSg = new ec2.SecurityGroup(this, 'AuroraSg', {
      vpc: this.vpc,
      description: 'Aurora - 5432 from ECS only',
    });
    this.auroraSg.addIngressRule(this.ecsSg, ec2.Port.tcp(5432), 'Postgres from ECS');

    this.redisSg = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc: this.vpc,
      description: 'Redis - 6379 from ECS only',
    });
    this.redisSg.addIngressRule(this.ecsSg, ec2.Port.tcp(6379), 'Redis from ECS');
  }
}
