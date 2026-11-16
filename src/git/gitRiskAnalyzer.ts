import {
	isGitReportPathExcluded,
	type GitFileChange,
	type GitFileStatus,
} from './gitStatusReader.js';

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';
export type RiskIndicatorSource = 'filename-pattern' | 'change-type';

export interface RiskFinding {
	level: RiskLevel;
	path: string;
	reason: string;
	source: RiskIndicatorSource;
	verifiedSecurityIssue: false;
}

interface RiskPattern {
	level: RiskLevel;
	pattern: RegExp;
	reason: string;
}

const filenamePatterns: RiskPattern[] = [
	{ level: 'critical', pattern: /(?:^|[\\/])\.env(?:\.[a-z0-9_-]+)?$/iu, reason: 'Filename may identify an environment or secret-bearing file' },
	{ level: 'critical', pattern: /(?:^|[\\/])(?:credentials?|secrets?)(?:\.(?:json|ya?ml|toml|ini|cfg|conf|txt))?$/iu, reason: 'Filename may identify a credential or secrets configuration file' },
	{ level: 'critical', pattern: /(?:^|[\\/])(?:tokens?|passwords?|passwd|api[_-]?keys?)(?:\.(?:json|ya?ml|toml|ini|cfg|conf|txt))$/iu, reason: 'Filename and configuration extension may identify stored credentials' },
	{ level: 'critical', pattern: /(?:^|[\\/])(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/\\]+\.(?:pem|key|p12|pfx|jks|keystore))$/iu, reason: 'Filename may identify private-key material' },
	{ level: 'critical', pattern: /(?:^|[\\/])(?:\.gnupg|\.pgp)[\\/](?:private-keys-v1\.d|secring(?:\.gpg)?)(?:[\\/].*)?$/iu, reason: 'Path may identify private-key storage' },
	{ level: 'high', pattern: /(?:^|[\\/])(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Gemfile\.lock|composer\.lock|Cargo\.lock)$/iu, reason: 'Dependency lock filename indicates supply-chain-sensitive metadata' },
	{ level: 'high', pattern: /(?:^|[\\/])(?:\.github[\\/]workflows|\.circleci|Jenkinsfile)(?:[\\/].*)?$/iu, reason: 'Path indicates CI/CD configuration' },
	{ level: 'high', pattern: /(?:^|[\\/])(?:migrations?|schemas?)(?:[\\/].*)?$/iu, reason: 'Path indicates database migration or schema content' },
	{ level: 'low', pattern: /(?:^|[\\/])(?:readme|changelog|contributing|license|notice)(?:\.[a-z0-9_-]+)?$/iu, reason: 'Filename indicates documentation' },
];

export function analyzeGitRisks(changes: readonly GitFileChange[]): RiskFinding[] {
	const findings: RiskFinding[] = [];
	for (const change of changes) {
		if (isGitReportPathExcluded(change.path)) {
			continue;
		}
		const filenameFinding = filenamePatterns.find((candidate) => candidate.pattern.test(change.path));
		if (filenameFinding) {
			findings.push({
				...filenameFinding,
				path: change.path,
				source: 'filename-pattern',
				verifiedSecurityIssue: false,
			});
			continue;
		}
		if (change.status === 'deleted'
			|| change.stagedStatus === 'deleted'
			|| change.unstagedStatus === 'deleted') {
			findings.push({
				level: 'medium',
				path: change.path,
				reason: 'Git reports a file deletion',
				source: 'change-type',
				verifiedSecurityIssue: false,
			});
		}
	}
	return findings;
}

export function riskLevelLabel(level: RiskLevel): string {
	return level.toUpperCase();
}

export function statusLabel(status: GitFileStatus | undefined): string {
	switch (status) {
		case 'added': return 'A';
		case 'modified': return 'M';
		case 'deleted': return 'D';
		case 'renamed': return 'R';
		case 'copied': return 'C';
		case 'untracked': return '?';
		default: return ' ';
	}
}
