import { useParams } from 'react-router-dom';

import { useServers } from '../../hooks/api/servers';

import { ComingSoon } from './ComingSoon';

/**
 * Placeholder for /servers/:id. Build from ServerDetail.dc.html,
 * ServerDetailLight.dc.html and ServerDetailMobile.dc.html with useServer(),
 * useServerSeries(), MetricCard, TimeRangePicker and TabLinks.
 */
export default function ServerDetailPage() {
  const { id } = useParams();
  const servers = useServers();
  const name = servers.data?.servers.find((server) => String(server.id) === id)?.name;
  return (
    <ComingSoon
      title={name ?? 'Server'}
      description="Live and historical CPU, memory, disk and network charts with thresholds, and this server’s incidents."
      header={{ monoTitle: name !== undefined, back: { to: '/', label: 'Back to overview' } }}
    />
  );
}
