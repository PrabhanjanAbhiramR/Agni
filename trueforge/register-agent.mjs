import { TrueForge } from '@truefoundry/trueforge-sdk';
import {
  createStandaloneAgniAgentDefinition,
} from '../out/trueforge/standaloneAgentDefinition.js';

const defaultServerUrl = 'http://localhost:8790';
const serverUrl = process.env.AGNI_TRUEFORGE_SERVER_URL?.trim() || defaultServerUrl;
const modelName = process.env.AGNI_TRUEFORGE_MODEL?.trim();

if (!modelName) {
  console.error('AGNI_TRUEFORGE_MODEL must contain an exact FQN returned by client.models.list().');
  process.exitCode = 1;
} else {
  const client = new TrueForge({ baseUrl: serverUrl, timeoutInSeconds: 600 });
  const definition = createStandaloneAgniAgentDefinition(modelName);
  const { data: agents } = await client.agents.list({
    agentName: definition.name,
    limit: 100,
  });
  const existing = agents.find((agent) => agent.name === definition.name);
  const { data: registered } = existing
    ? await client.agents.update(existing.id, {
        description: definition.description,
        manifest: definition.manifest,
      })
    : await client.agents.create(definition);

  console.log(`${existing ? 'Updated' : 'Created'} TrueForge agent ${registered.name} (${registered.id}).`);
}
