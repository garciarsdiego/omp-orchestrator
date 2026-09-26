let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  switch (process.argv[2]) {
    case "success":
      process.stdout.write(JSON.stringify({ output: `received:${prompt}`, usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }, events: [{ type: "fake.done" }] }));
      break;
    case "invalid":
      process.stdout.write("not-json");
      break;
    case "unknown-usage":
      process.stdout.write(JSON.stringify({ output: "usage unavailable" }));
      break;
    case "large":
      process.stdout.write(JSON.stringify({ output: "x".repeat(20_000) }));
      break;
    case "hang":
      setInterval(() => {}, 1_000);
      break;
    case "ignore-term":
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1_000);
      break;
    case "stderr-prompt":
      process.stderr.write(`diagnostic:${prompt}`);
      process.exitCode = 2;
      break;
    default:
      process.stderr.write("unknown mode");
      process.exitCode = 2;
  }
});
