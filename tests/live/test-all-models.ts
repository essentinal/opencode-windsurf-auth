#!/usr/bin/env bun
/**
 * Test all models in the enum to verify they work with Windsurf API
 * 
 * Tests each canonical model with a simple request to verify:
 * 1. The model enum is accepted by the API
 * 2. The model returns a valid response
 * 3. No gRPC errors occur
 */

import { getCredentials, isWindsurfRunning, WindsurfCredentials } from '../../src/plugin/auth.js';
import { streamChat, ChatMessage } from '../../src/plugin/grpc-client.js';
import { getCanonicalModels, modelNameToEnum } from '../../src/plugin/models.js';

interface TestResult {
  model: string;
  enumValue: number;
  status: 'pass' | 'fail' | 'skip';
  responseLength: number;
  error?: string;
  duration: number;
}

const TEST_PROMPT = 'Reply with exactly one word: "OK"';

async function testModel(
  credentials: WindsurfCredentials,
  model: string,
  timeoutMs: number = 30000
): Promise<TestResult> {
  const enumValue = modelNameToEnum(model);
  const start = Date.now();
  
  const messages: ChatMessage[] = [
    { role: 'user', content: TEST_PROMPT }
  ];

  try {
    const response = await Promise.race([
      streamChat(credentials, { model, messages }),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), timeoutMs)
      )
    ]);

    const duration = Date.now() - start;
    
    return {
      model,
      enumValue,
      status: 'pass',
      responseLength: response.length,
      duration,
    };
  } catch (error) {
    const duration = Date.now() - start;
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    return {
      model,
      enumValue,
      status: 'fail',
      responseLength: 0,
      error: errorMessage,
      duration,
    };
  }
}

async function main() {
  console.log('=== Windsurf Model Verification Test ===\n');

  // Pre-check
  if (!isWindsurfRunning()) {
    console.error('ERROR: Windsurf is not running. Please start Windsurf first.');
    process.exit(1);
  }

  const credentials = getCredentials();
  console.log(`Connected to Windsurf on port ${credentials.port}\n`);

  const allModels = getCanonicalModels();
  console.log(`Testing ${allModels.length} canonical models...\n`);

  // Parse command line args
  const args = process.argv.slice(2);
  const parallelCount = parseInt(args.find(a => a.startsWith('--parallel='))?.split('=')[1] || '1');
  const filterPattern = args.find(a => a.startsWith('--filter='))?.split('=')[1];
  const skipModels = (args.find(a => a.startsWith('--skip='))?.split('=')[1] || '').split(',').filter(Boolean);
  const timeoutMs = parseInt(args.find(a => a.startsWith('--timeout='))?.split('=')[1] || '30000');

  let modelsToTest = allModels;
  
  if (filterPattern) {
    const regex = new RegExp(filterPattern, 'i');
    modelsToTest = modelsToTest.filter(m => regex.test(m));
    console.log(`Filtered to ${modelsToTest.length} models matching "${filterPattern}"\n`);
  }

  if (skipModels.length > 0) {
    modelsToTest = modelsToTest.filter(m => !skipModels.includes(m));
    console.log(`Skipping ${skipModels.length} models\n`);
  }

  const results: TestResult[] = [];
  const passed: string[] = [];
  const failed: string[] = [];

  // Test models (sequentially by default to avoid rate limits)
  if (parallelCount > 1) {
    console.log(`Running ${parallelCount} tests in parallel...\n`);
    
    for (let i = 0; i < modelsToTest.length; i += parallelCount) {
      const batch = modelsToTest.slice(i, i + parallelCount);
      const batchResults = await Promise.all(
        batch.map(model => testModel(credentials, model, timeoutMs))
      );
      
      for (const result of batchResults) {
        results.push(result);
        printResult(result);
        
        if (result.status === 'pass') {
          passed.push(result.model);
        } else {
          failed.push(result.model);
        }
      }
      
      // Small delay between batches to avoid rate limiting
      if (i + parallelCount < modelsToTest.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } else {
    for (const model of modelsToTest) {
      const result = await testModel(credentials, model, timeoutMs);
      results.push(result);
      printResult(result);
      
      if (result.status === 'pass') {
        passed.push(result.model);
      } else {
        failed.push(result.model);
      }
      
      // Small delay between requests
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total:  ${results.length}`);
  console.log(`Passed: ${passed.length} (${((passed.length / results.length) * 100).toFixed(1)}%)`);
  console.log(`Failed: ${failed.length}`);
  
  if (failed.length > 0) {
    console.log('\nFailed models:');
    for (const model of failed) {
      const result = results.find(r => r.model === model)!;
      console.log(`  - ${model}: ${result.error}`);
    }
  }

  // Write detailed results to file
  const reportPath = 'tests/live/model-test-results.json';
  await Bun.write(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    credentials: {
      port: credentials.port,
      version: credentials.version,
    },
    summary: {
      total: results.length,
      passed: passed.length,
      failed: failed.length,
    },
    results,
  }, null, 2));
  console.log(`\nDetailed results saved to ${reportPath}`);

  // Exit with error if any failed
  if (failed.length > 0) {
    process.exit(1);
  }
}

function printResult(result: TestResult) {
  const statusIcon = result.status === 'pass' ? '✓' : '✗';
  const statusColor = result.status === 'pass' ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';
  
  const duration = `${(result.duration / 1000).toFixed(1)}s`;
  const info = result.status === 'pass' 
    ? `${result.responseLength} chars`
    : result.error?.slice(0, 50);
  
  console.log(
    `${statusColor}${statusIcon}${reset} ` +
    `${result.model.padEnd(30)} ` +
    `(${result.enumValue.toString().padStart(3)}) ` +
    `${duration.padStart(6)} ` +
    `${info}`
  );
}

main().catch((error) => {
  console.error('\nFatal error:', error);
  process.exit(1);
});
