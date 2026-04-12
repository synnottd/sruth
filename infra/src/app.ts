#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { testConfig } from './config.js';
import { NetworkStack } from './stacks/network-stack.js';
import { DataStack } from './stacks/data-stack.js';
import { ServiceStack } from './stacks/service-stack.js';

const app = new cdk.App();

const env = { account: testConfig.account, region: testConfig.region };

const network = new NetworkStack(app, 'OmegaStreamNetwork', { env });

const data = new DataStack(app, 'OmegaStreamData', {
  env,
  network,
  config: testConfig,
});

new ServiceStack(app, 'OmegaStreamService', {
  env,
  network,
  data,
  config: testConfig,
});

app.synth();
