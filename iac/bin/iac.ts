import { App, Tags } from "aws-cdk-lib";
import { IacStack } from "../lib/iac-stack.js";
import { synthesizer } from "../lib/synthesizer.js";

const app = new App();
Tags.of(app).add("Project", "samply-mcp");
new IacStack(app, "samply-mcp-iac", { env: { account: "209479295726", region: "eu-west-1" }, synthesizer: synthesizer() });
