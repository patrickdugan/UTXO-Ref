import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import {
  TlusdLiquidityPatchClient,
  TlusdLiquidityPatchWalletView,
  WalletDemoBackendConfig,
  WalletDemoStatus
} from './tlusdLiquidityPatchClient';

type Props = {
  client?: TlusdLiquidityPatchClient;
};

function sats(value: string) {
  return `${Number(value).toLocaleString()} sats`;
}

function tlusd(value: string) {
  return `${(Number(value) / 1000000).toLocaleString(undefined, { maximumFractionDigits: 6 })} TLUSD`;
}

function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'good' | 'warn' | 'neutral' }) {
  const backgroundColor = tone === 'good' ? '#065f46' : tone === 'warn' ? '#92400e' : '#374151';
  return (
    <View style={{ alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 4, backgroundColor }}>
      <Text style={{ color: '#ffffff', fontSize: 12 }}>{label}</Text>
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

export default function TlusdLiquidityPatchScreen({ client = new TlusdLiquidityPatchClient() }: Props) {
  const [config, setConfig] = useState<WalletDemoBackendConfig | null>(null);
  const [demoStatus, setDemoStatus] = useState<WalletDemoStatus | null>(null);
  const [view, setView] = useState<TlusdLiquidityPatchWalletView | null>(null);
  const [status, setStatus] = useState<string>('Loading');

  useEffect(() => {
    Promise.all([client.getBackendConfig(), client.getDemoStatus(), client.getWalletView()])
      .then(([nextConfig, nextStatus, nextView]) => {
        setConfig(nextConfig);
        setDemoStatus(nextStatus);
        setView(nextView);
        setStatus(nextView.status === 'verified' ? 'Patch verified' : 'Needs attention');
      })
      .catch(err => setStatus(err.message));
  }, [client]);

  async function verify() {
    const result = await client.verifyPatch();
    setStatus(result.ok ? `Verified ${sats(result.assignedInboundSats)} assigned` : result.reason || 'Verification failed');
  }

  async function challenge() {
    const result = await client.prepareChallenge();
    setStatus(result.slashable ? `Challenge ready: ${result.violations.join(', ')}` : 'No challenge available');
  }

  function markConverted() {
    setStatus(`Loaded ${sats(view?.conversion.lnbtcSats || '0')} as ${tlusd(view?.conversion.tlusdUnits || '0')}`);
  }

  function markStaked() {
    setStatus(`Stake staged: ${tlusd(view?.stake.stakedTlUsdUnits || '0')} for ${sats(view?.stake.routingNotionalSats || '0')}`);
  }

  if (!view || !config || !demoStatus) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
        <Text>{status}</Text>
      </View>
    );
  }

  const lifecycle = [
    ['LN-BTC received', sats(view.conversion.lnbtcSats), true],
    ['TLUSD issued', tlusd(view.conversion.tlusdUnits), true],
    ['TLUSD staked', tlusd(view.stake.stakedTlUsdUnits), true],
    ['Liquidity patched', sats(view.liquidityPatch.totals.assignedInboundSats), Number(view.liquidityPatch.totals.assignedInboundSats) > 0],
    [
      view.liquidityPatch.challenge.slashable ? 'Challengeable' : 'Verified',
      view.liquidityPatch.challenge.slashable
        ? `${view.liquidityPatch.totals.slashableAssignments} route needs action`
        : 'No route challenge',
      true
    ]
  ] as Array<[string, string, boolean]>;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: '700' }}>{view.title}</Text>
      <Text>{view.subtitle}</Text>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Badge label={config.activeProfile.chainSourceBadge} tone="good" />
        <Badge label={config.activeProfile.mode} />
        <Badge label={demoStatus.artifacts.lnbtcTlusdLiquidityPatch.exists ? 'artifact loaded' : 'artifact missing'} tone={demoStatus.artifacts.lnbtcTlusdLiquidityPatch.exists ? 'good' : 'warn'} />
        <Badge label={view.liquidityPatch.challenge.slashable ? 'challengeable' : 'verified'} tone={view.liquidityPatch.challenge.slashable ? 'warn' : 'good'} />
      </View>
      <Text>Status: {status}</Text>

      <Section title="Lifecycle">
        {lifecycle.map(([label, detail, ok]) => (
          <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <Text>{ok ? 'OK' : 'WAIT'} {label}</Text>
            <Text>{detail}</Text>
          </View>
        ))}
      </Section>

      <Section title="Conversion">
        <Text>LN-BTC input: {sats(view.conversion.lnbtcSats)}</Text>
        <Text>TLUSD balance: {tlusd(view.conversion.tlusdUnits)}</Text>
        <Text selectable>RFQ: {view.conversion.rfqQuoteId}</Text>
        <Text selectable>UTXORef funding: {view.conversion.dlcFundingTxid}</Text>
      </Section>

      <Section title="Stake">
        <Text>Staked: {tlusd(view.stake.stakedTlUsdUnits)}</Text>
        <Text>Routing notional: {sats(view.stake.routingNotionalSats)}</Text>
        <Text>Lock: {view.stake.lockBlocks} blocks</Text>
        <Text>Target yield: {view.stake.targetYieldPpm} ppm</Text>
      </Section>

      <Section title="Liquidity Patch">
        <Text>Assigned: {sats(view.liquidityPatch.totals.assignedInboundSats)}</Text>
        <Text>Delivered: {sats(view.liquidityPatch.totals.deliveredInboundSats)}</Text>
        <Text>Slashable routes: {view.liquidityPatch.totals.slashableAssignments}</Text>
        {view.liquidityPatch.assignments.map(route => (
          <Text key={route.routeId}>
            {route.routeId}: {route.status}, {sats(route.deliveredInboundSats)} delivered
          </Text>
        ))}
      </Section>

      <Section title="Enforcement">
        <Text selectable>Challenge: {view.liquidityPatch.challenge.challengeId}</Text>
        <Text>Remedy: {view.liquidityPatch.challenge.remedy}</Text>
        <Text>Ark marginal cost: {sats(view.liquidityPatch.costModel.arkPerGraftSats)} per graft</Text>
        <Text>Baseline marginal cost: {sats(view.liquidityPatch.costModel.baselinePerGraftSats)} per graft</Text>
      </Section>

      <Pressable onPress={markConverted} style={{ padding: 12, backgroundColor: '#1f2937' }}>
        <Text style={{ color: '#ffffff' }}>Convert LN-BTC to TLUSD</Text>
      </Pressable>
      <Pressable onPress={markStaked} style={{ padding: 12, backgroundColor: '#1f2937' }}>
        <Text style={{ color: '#ffffff' }}>Stake TLUSD</Text>
      </Pressable>
      <Pressable onPress={verify} style={{ padding: 12, backgroundColor: '#111827' }}>
        <Text style={{ color: '#ffffff' }}>Verify patch evidence</Text>
      </Pressable>
      {view.liquidityPatch.challenge.slashable ? (
        <Pressable onPress={challenge} style={{ padding: 12, backgroundColor: '#7f1d1d' }}>
          <Text style={{ color: '#ffffff' }}>Prepare challenge</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
