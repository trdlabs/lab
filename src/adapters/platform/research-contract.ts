import type { ResearchCapabilityDescriptor } from '../../ports/research-platform.port.ts';

export class ContractIncompatibleError extends Error {
  readonly expected: string;
  readonly actual: string;
  readonly supported: readonly string[];

  constructor(expected: string, actual: string, supported: readonly string[]) {
    super(
      `platform contract ${actual} is incompatible with expected ${expected} ` +
      `(supported: ${supported.length ? supported.join(', ') : 'none'})`,
    );
    this.name = 'ContractIncompatibleError';
    this.expected = expected;
    this.actual = actual;
    this.supported = supported;
  }
}

/** Fail-closed: throw unless the expected version is the platform's version or in its supported set. */
export function assertContractCompatible(
  descriptor: ResearchCapabilityDescriptor,
  expected: string,
): void {
  const ok =
    descriptor.contractVersion === expected ||
    descriptor.supportedContractVersions.includes(expected);
  if (!ok) {
    throw new ContractIncompatibleError(expected, descriptor.contractVersion, descriptor.supportedContractVersions);
  }
}
