import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var bridge: BridgeClient
    @State private var selection: SidebarItem? = .chats

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Label("Parear", systemImage: "qrcode").tag(SidebarItem.onboarding)
                Label("Chats", systemImage: "bubble.left.and.bubble.right").tag(SidebarItem.chats)
                Label("Status", systemImage: "antenna.radiowaves.left.and.right").tag(SidebarItem.status)
                Label("Ajustes", systemImage: "gearshape").tag(SidebarItem.settings)
            }
            .navigationTitle("IAZAP")
            .listStyle(.sidebar)
        } detail: {
            switch selection ?? .chats {
            case .onboarding:
                OnboardingView()
            case .chats:
                ChatListView()
            case .status:
                StatusView()
            case .settings:
                SettingsView()
            }
        }
        .toolbar {
            ToolbarItem(placement: .automatic) {
                HStack(spacing: 8) {
                    Circle()
                        .fill(bridge.sessionStatus.state.color)
                        .frame(width: 8, height: 8)
                    Text(bridge.sessionStatus.state.label)
                        .foregroundStyle(.secondary)
                        .font(.caption)
                }
            }
        }
    }
}

private enum SidebarItem: Hashable {
    case onboarding, chats, status, settings
}

#Preview {
    ContentView()
        .environmentObject(AppStore())
        .environmentObject(BridgeClient())
}
