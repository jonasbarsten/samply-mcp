import { DefaultStackSynthesizer } from "aws-cdk-lib";

/** Its own bootstrap qualifier, so samply-mcp stacks use their own bootstrap roles and asset bucket, not fiken-mcp's or byjoba's. */
export const QUALIFIER = "samplymcp";

export function synthesizer(): DefaultStackSynthesizer {
  return new DefaultStackSynthesizer({ qualifier: QUALIFIER });
}
