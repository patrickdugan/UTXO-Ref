import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { LiquidityLeaseClient, LiquidityLeaseWalletView } from './liquidityLeaseClient';

type Props = {
  client?: LiquidityLeaseClient;
};

export default function LiquidityLeaseScreen({ client = new LiquidityLeaseClient() }: Props) {
  const [view, setView] = useState<LiquidityLeaseWalletView | null>(null);
  const [status, setStatus] = useState<string>('Loading');

  useEffect(() => {
    client.getWalletView()
      .then(next => {
        setView(next);
        setStatus(next.status === 'verified' ? 'Lease verified' : 'Needs attention');
      })
      .catch(err => setStatus(err.message));
  }, [client]);

  async function verify() {
    const result = await client.verifyLease();
    setStatus(result.ok ? 'Lease verified' : result.reason || 'Verification failed');
  }

  async function challenge() {
    const result = await client.prepareChallenge();
    setStatus(result.slashable ? `Challenge ready: ${result.violations.join(', ')}` : 'No challenge available');
  }

  if (!view) {
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
      <Text>Status: {status}</Text>

      <View style={{ gap: 6 }}>
        <Text>Inbound: {view.amountSats} sats</Text>
        <Text>Max fee: {view.maxFeePpm} ppm</Text>
        <Text>Max CLTV delta: {view.maxCltvDelta}</Text>
        <Text>Penalty: {view.penaltySats} sats</Text>
        <Text selectable>Channel/splice: {view.channelOutpoint}</Text>
        <Text selectable>Payment hash: {view.paymentHashHex}</Text>
        <Text selectable>Funding commitment: {view.fundingCommitmentHash}</Text>
      </View>

      <Pressable onPress={verify} style={{ padding: 12, backgroundColor: '#111827' }}>
        <Text style={{ color: '#ffffff' }}>Verify lease evidence</Text>
      </Pressable>
      <Pressable onPress={challenge} style={{ padding: 12, backgroundColor: '#7f1d1d' }}>
        <Text style={{ color: '#ffffff' }}>Prepare challenge</Text>
      </Pressable>
    </ScrollView>
  );
}
