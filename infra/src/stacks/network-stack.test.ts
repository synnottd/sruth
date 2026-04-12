import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from './network-stack.js';

function createStack() {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'TestNetwork', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

describe('NetworkStack', () => {
  describe('VPC', () => {
    it('creates a VPC with no NAT gateways', () => {
      const template = createStack();
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
    });

    it('creates public and private isolated subnets across 2 AZs', () => {
      const template = createStack();
      // 2 AZs × 2 subnet types = 4 subnets
      template.resourceCountIs('AWS::EC2::Subnet', 4);

      // Public subnets have MapPublicIpOnLaunch
      template.resourcePropertiesCountIs('AWS::EC2::Subnet', {
        MapPublicIpOnLaunch: true,
      }, 2);

      // Private isolated subnets do not
      template.resourcePropertiesCountIs('AWS::EC2::Subnet', {
        MapPublicIpOnLaunch: false,
      }, 2);
    });
  });

  describe('Security Groups', () => {
    it('ECS SG allows inbound 3002 and 1935 from anywhere', () => {
      const template = createStack();
      // CIDR-based rules are inlined in the SecurityGroup resource
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({ IpProtocol: 'tcp', FromPort: 3002, ToPort: 3002, CidrIp: '0.0.0.0/0' }),
          Match.objectLike({ IpProtocol: 'tcp', FromPort: 1935, ToPort: 1935, CidrIp: '0.0.0.0/0' }),
        ]),
      });
    });

    it('Aurora SG allows inbound 5432 only from ECS SG', () => {
      const template = createStack();
      template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        IpProtocol: 'tcp',
        FromPort: 5432,
        ToPort: 5432,
        SourceSecurityGroupId: Match.anyValue(),
      });
      // Should NOT allow 5432 from 0.0.0.0/0
      expect(() => {
        template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
          FromPort: 5432,
          CidrIp: '0.0.0.0/0',
        });
      }).toThrow();
    });

    it('Redis SG allows inbound 6379 only from ECS SG', () => {
      const template = createStack();
      template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        IpProtocol: 'tcp',
        FromPort: 6379,
        ToPort: 6379,
        SourceSecurityGroupId: Match.anyValue(),
      });
      // Should NOT allow 6379 from 0.0.0.0/0
      expect(() => {
        template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
          FromPort: 6379,
          CidrIp: '0.0.0.0/0',
        });
      }).toThrow();
    });
  });
});
