// Run the complete compatibility probe by default, independent of shell syntax.
process.env.G1_ADAPTER = '1';
process.env.G1_QUOTA = '1';
await import('../experiments/g1-external-auth.mjs');
