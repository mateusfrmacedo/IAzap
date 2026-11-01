import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var bridge: BridgeClient
    @EnvironmentObject private var store: AppStore
    @State private var selection: SidebarItem? = .onboarding

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Label("Parear", systemImage: "qrcode").tag(SidebarItem.onboarding)
                Label("Chats", systemImage: "bubble.left.and.bubble.right").tag(SidebarItem.chats)
                Label("Atendimento", systemImage: "list.bullet.rectangle").tag(SidebarItem.automation)
                Label("Status", systemImage: "antenna.radiowaves.left.and.right").tag(SidebarItem.status)
                Label("Ajustes", systemImage: "gearshape").tag(SidebarItem.settings)
            }
            .navigationTitle("ZapIA")
            .listStyle(.sidebar)
        } detail: {
            switch selection ?? .onboarding {
            case .onboarding:
                OnboardingView()
            case .chats:
                ChatListView()
            case .automation:
                AutomationView()
            case .status:
                StatusView()
            case .settings:
                SettingsView()
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                HStack(spacing: 8) {
                    Circle()
                        .fill(bridge.sessionStatus.state.color)
                        .frame(width: 8, height: 8)
                    Text(bridge.sessionStatus.state.label)
                        .foregroundStyle(.secondary)
                        .font(.caption)
                    Text("·")
                        .foregroundStyle(.tertiary)
                        .font(.caption)
                    Text(bridge.pipelineStatus.enabled ? "auto‑reply on" : "auto‑reply off")
                        .foregroundStyle(bridge.pipelineStatus.enabled ? .green : .secondary)
                        .font(.caption)
                }
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .accessibilityElement(children: .combine)
            }
        }
        .onChange(of: bridge.sessionStatus.state) { _, newState in
            // After first successful pair, nudge toward chats once.
            if newState == .connected, selection == .onboarding, store.tosRiskAccepted {
                // stay on Parear so user sees connected confirmation; they can switch manually
            }
        }
    }
}

private enum SidebarItem: Hashable {
    case onboarding, chats, automation, status, settings
}

#Preview {
    ContentView()
        .environmentObject(AppStore())
        .environmentObject(BridgeClient())
}
