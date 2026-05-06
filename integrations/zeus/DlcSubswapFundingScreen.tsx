import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import {
  DlcSubswapFundingClient,
  DlcSubswapFundingWalletView
} from './dlcSubswapFundingClient';

type Props = {
  client?: DlcSubswapFundingClient;
};

function Row({ label, value }: { label: string; value?: string | number | boolean | null }) {
  return (
    <View style={{ gap: 4, paddingVertical: 4 }}>
      <Text style={{ fontWeight: '700' }}>{label}</Text>
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

export default function DlcSubswapFundingScreen({ client = new DlcSubswapFundingClient() }: Props) {
  const [view, setView] = useState<DlcSubswapFundingWalletView | null>(null);
  const [message, setMessage] = useState('Loading');

  useEffect(() => {
    client.getWalletView()
      .then(next => {
        setView(next);
        setMessage(next.status === 'verified' ? 'DLC funding route verified' : 'DLC funding route needs attention');
      })
      .catch(err => setMessage(err.message));
  }, [client]);

  async function refreshQuote() {
    const quote = await client.quote();
    setView(quote.walletView);
    setMessage(quote.walletView.status === 'verified' ? 'Quote verified' : 'Quote needs attention');
  }

  async function verify() {
    const result = await client.verify();
    setMessage(result.ok ? 'Funding request verified' : result.reason || 'Funding request failed');
  }

  if (!view) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
        <Text>{message}</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: '700' }}>{view.title}</Text>
      <Text>{view.subtitle}</Text>
      <Text>Status: {message}</Text>

      <Section title="Funding Invoice">
        <Row label="Invoice amount" value={`${view.invoiceAmountSats} sats`} />
        <Row label="Requested collateral" value={`${view.requestedCollateralSats} sats`} />
        <Row label="Payment hash" value={view.paymentHashHex} />
        <Row label="Invoice" value={view.invoice} />
      </Section>

      <Section title="DLC Binding">
        <Row label="Request id" value={view.requestId} />
        <Row label="Contract commitment" value={view.targetContractCommitmentId} />
        <Row label="Funding commitment" value={view.fundingCommitmentHash} />
        <Row label="Target binding" value={view.targetBindingHash} />
        <Row label="Namespace" value={view.namespaceHandle} />
      </Section>

      <Section title="Execution Proof">
        <Row label="Swap funding txid" value={view.execution?.swapFundingTxid} />
        <Row label="Claim txid" value={view.execution?.claimTxid} />
        <Row label="Refund txid" value={view.execution?.refundTxid} />
        {view.execution?.checks &&
          Object.entries(view.execution.checks).map(([name, ok]) => (
            <Row key={name} label={name} value={ok} />
          ))}
      </Section>

      <Pressable onPress={refreshQuote} style={{ padding: 12, backgroundColor: '#111827' }}>
        <Text style={{ color: '#ffffff' }}>Refresh UTXORef quote</Text>
      </Pressable>
      <Pressable onPress={verify} style={{ padding: 12, backgroundColor: '#1d4ed8' }}>
        <Text style={{ color: '#ffffff' }}>Verify funding request</Text>
      </Pressable>
    </ScrollView>
  );
}
