import { describe, expect, it } from 'vitest';

import {
  GOOGLE_ACTIVE_PERSONAL_CAPABILITIES,
  GOOGLE_CAPABILITY_CATALOG,
  OCTOGEE_CONTROLLED_GOG_COMMAND_FAMILIES,
  googleCapabilityDefinition,
} from './google-capabilities.js';

describe('Google capability catalog', () => {
  it('keeps the live personal OAuth surface limited to implemented capabilities', () => {
    expect(GOOGLE_ACTIVE_PERSONAL_CAPABILITIES.map((capability) => capability.id)).toEqual([
      'calendar',
      'gmail',
      'drive',
      'tasks',
      'contacts',
    ]);
  });

  it('captures each Gog service family with its distinct credential authority', () => {
    expect(googleCapabilityDefinition('keep')).toMatchObject({
      authMode: 'workspace-domain-wide-delegation',
      availability: 'catalogued',
    });
    expect(googleCapabilityDefinition('admin-directory')).toMatchObject({
      authMode: 'workspace-domain-wide-delegation',
      approvalClass: 'destructive',
    });
    expect(googleCapabilityDefinition('maps')).toMatchObject({ authMode: 'api-key' });
    expect(googleCapabilityDefinition('zoom')).toMatchObject({ authMode: 'separate-oauth' });
    expect(googleCapabilityDefinition('missing')).toBeUndefined();
  });

  it('does not turn CLI-local or generic API commands into model-callable capabilities', () => {
    expect(OCTOGEE_CONTROLLED_GOG_COMMAND_FAMILIES.flatMap((family) => family.commandFamilies)).toEqual(
      expect.arrayContaining(['auth', 'config', 'api', 'time']),
    );
    expect(GOOGLE_CAPABILITY_CATALOG.flatMap((capability) => capability.commandFamilies)).not.toContain('api');
  });
});
