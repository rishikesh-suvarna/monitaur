import { useParams } from 'react-router-dom';

import { useServers } from '../../hooks/api/servers';

import { ComingSoon } from './ComingSoon';

/**
 * Placeholder for /servers/:id/settings. Build from ServerSettings.dc.html
 * and ServerSettingsMobile.dc.html with TagInput, Toggle and the
 * type-to-confirm ConfirmDialog.
 */
export default function ServerSettingsPage() {
  const { id } = useParams();
  const servers = useServers();
  const name = servers.data?.servers.find((server) => String(server.id) === id)?.name;
  return (
    <ComingSoon
      title={name ? `${name} settings` : 'Server settings'}
      description="Rename, tags, the rules on this server, token rotation and the danger zone."
      header={{ monoTitle: name !== undefined, back: { to: id ? `/servers/${id}` : '/', label: 'Back to server' } }}
    />
  );
}
