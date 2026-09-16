for (const name of ["ANTHROPIC_BASE_URL", "OPENROUTER_BASE_URL", "PLATFORM_OPENAI_BASE_URL"]) {
  delete process.env[name];
}
