import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import {
  TlusdLiquidityPatchClient,
  TlusdLiquidityPatchWalletView,
  WalletDemoBackendConfig
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

export default function TlusdLiquidityPatchScreen({ client = new TlusdLiquidityPatchClient() }: Props) {
  const [config, setConfig] = useState<WalletDemoBackendConfig | null>(null);
  const [view, setView] = useState<TlusdLiquidityPatchWalletView | null>(null);
  const [status, setStatus] = useState<string>('Loading');

  useEffect(() => {
    Promise.all([client.getBackendConfig(), client.getWalletView()])
      .then(([nextConfig, nextView]) => {
        setConfig(nextConfig);
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

  if (!view || !config) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
        <Text>{status}</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: '700' }}>{view.title}</Text>
      <Text>{view.subtitle}</Text>
      <Text>Backend: {config.activeProfile.displayName}</Text>
      <Text>Chain: {config.activeProfile.chainSourceBadge}</Text>
      <Text>Status: {status}</Text>

      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 16, fontWeight: '700' }}>Conversion</Text>
        <Text>LN-BTC input: {sats(view.conversion.lnbtcSats)}</Text>
        <Text>TLUSD balance: {tlusd(view.conversion.tlusdUnits)}</Text>
        <Text selectable>RFQ: {view.conversion.rfqQuoteId}</Text>
        <Text selectable>UTXORef funding: {view.conversion.dlcFundingTxid}</Text>
      </View>

      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 16, fontWeight: '700' }}>Stake</Text>
        <Text>Staked: {tlusd(view.stake.stakedTlUsdUnits)}</Text>
        <Text>Routing notional: {sats(view.stake.routingNotionalSats)}</Text>
        <Text>Lock: {view.stake.lockBlocks} blocks</Text>
        <Text>Target yield: {view.stake.targetYieldPpm} ppm</Text>
      </View>

      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 16, fontWeight: '700' }}>Liquidity Patch</Text>
        <Text>Assigned: {sats(view.liquidityPatch.totals.assignedInboundSats)}</Text>
        <Text>Delivered: {sats(view.liquidityPatch.totals.deliveredInboundSats)}</Text>
        <Text>Slashable routes: {view.liquidityPatch.totals.slashableAssignments}</Text>
        {view.liquidityPatch.assignments.map(route => (
          <Text key={route.routeId}>
            {route.routeId}: {route.status}, {sats(route.deliveredInboundSats)} delivered
          </Text>
        ))}
      </View>

      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 16, fontWeight: '700' }}>Enforcement</Text>
        <Text selectable>Challenge: {view.liquidityPatch.challenge.challengeId}</Text>
        <Text>Remedy: {view.liquidityPatch.challenge.remedy}</Text>
      </View>

      <Pressable onPress={verify} style={{ padding: 12, backgroundColor: '#111827' }}>
        <Text style={{ color: '#ffffff' }}>Verify patch evidence</Text>
      </Pressable>
      <Pressable onPress={challenge} style={{ padding: 12, backgroundColor: '#7f1d1d' }}>
        <Text style={{ color: '#ffffff' }}>Prepare challenge</Text>
      </Pressable>
    </ScrollView>
  );
}
