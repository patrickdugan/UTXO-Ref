import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import {
  TlusdLiquidityPatchClient,
  WalletDemoBackendConfig,
  WalletDemoStatus
} from './tlusdLiquidityPatchClient';

type Props = {
  client?: TlusdLiquidityPatchClient;
};

function Row({ label, value }: { label: string; value?: string | number | boolean | null }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      <Text>{label}</Text>
      <Text selectable>{value === undefined || value === null ? 'n/a' : String(value)}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6, paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#e5e7eb' }}>
      <Text style={{ fontSize: 16, fontWeight: '700' }}>{title}</Text>
      {children}
    </View>
  );
}

export default function WalletDemoSettingsScreen({ client = new TlusdLiquidityPatchClient() }: Props) {
  const [config, setConfig] = useState<WalletDemoBackendConfig | null>(null);
  const [status, setStatus] = useState<WalletDemoStatus | null>(null);
  const [message, setMessage] = useState('Loading');

  useEffect(() => {
    Promise.all([client.getBackendConfig(), client.getDemoStatus()])
      .then(([nextConfig, nextStatus]) => {
        setConfig(nextConfig);
        setStatus(nextStatus);
        setMessage(nextStatus.readiness.walletViewReady ? 'Wallet demo ready' : 'Wallet demo needs attention');
      })
      .catch(err => setMessage(err.message));
  }, [client]);

  if (!config || !status) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
        <Text>{message}</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: '700' }}>UTXORef Wallet Demo</Text>
      <Text>{message}</Text>

      <Section title="Active Profile">
        <Row label="Profile" value={config.activeProfileId} />
        <Row label="Mode" value={config.activeProfile.mode} />
        <Row label="Chain badge" value={config.activeProfile.chainSourceBadge} />
        <Row label="Sidecar" value={config.activeProfile.sidecarBaseUrl} />
      </Section>

      <Section title="Chain Backend">
        <Row label="Chain" value={status.chain.chain} />
        <Row label="RPC URL" value={status.chain.rpcUrl} />
        <Row label="Wallet" value={status.chain.wallet} />
        <Row label="Status" value={status.chain.status} />
      </Section>

      <Section title="LND">
        <Row label="Network" value={status.lnd?.network} />
        <Row label="REST" value={status.lnd?.restUrl} />
        <Row label="gRPC" value={status.lnd?.grpcHost} />
        <Row label="Macaroon configured" value={status.lnd?.macaroonConfigured} />
        <Row label="TLS configured" value={status.lnd?.tlsConfigured} />
      </Section>

      <Section title="Artifacts">
        <Row label="TLUSD patch artifact" value={status.artifacts.lnbtcTlusdLiquidityPatch.exists} />
        <Row label="Updated" value={status.artifacts.lnbtcTlusdLiquidityPatch.updatedAt} />
        <Row label="Verified" value={status.artifacts.lnbtcTlusdLiquidityPatch.summary?.ok} />
        <Row label="Assigned inbound" value={status.artifacts.lnbtcTlusdLiquidityPatch.summary?.assignedInboundSats} />
      </Section>

      <Section title="Readiness">
        <Row label="Wallet view ready" value={status.readiness.walletViewReady} />
        <Row label="Local Litecoin ready" value={status.readiness.localLitecoinReady} />
        <Row label="Bitcoin LND ready" value={status.readiness.bitcoinLndReady} />
        {status.readiness.warnings.map(warning => (
          <Text key={warning}>{warning}</Text>
        ))}
      </Section>

      <Section title="Switch Plan">
        <Row label="Current demo" value={config.switchPlan.currentDemo} />
        <Row label="Go live" value={config.switchPlan.goLive} />
        <Text>{config.switchPlan.invariant}</Text>
      </Section>
    </ScrollView>
  );
}
