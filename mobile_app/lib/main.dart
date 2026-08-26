import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'theme/app_theme.dart';
import 'screens/splash_screen.dart';
import 'screens/login_screen.dart';
import 'screens/main_screen.dart';
import 'screens/lab_detail_screen.dart';
import 'screens/map_screen.dart';
import 'screens/lab_map_screen.dart';
import 'screens/wallet_screen.dart';
import 'screens/wallet_transfer_screen.dart';
import 'screens/gamer_profile_edit_screen.dart';
import 'screens/friends_screen.dart';
import 'screens/friend_profile_screen.dart';
import 'screens/squad_invite_screen.dart';
import 'screens/tournament_detail_screen.dart';
import 'screens/achievements_screen.dart';
import 'screens/stats_screen.dart';
import 'screens/referral_screen.dart';
import 'screens/bookings_screen.dart';
import 'screens/my_clubs_screen.dart';
import 'screens/forgot_password_screen.dart';
import 'screens/otp_screen.dart';
import 'screens/new_password_screen.dart';
import 'services/notification_service.dart';
import 'services/api_service.dart';
import 'services/lang_service.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.light,
  ));
  // Darhol UI ko'rsatamiz — init fonda ketadi
  runApp(const DefuseApp());
  _initServices();
}

Future<void> _initServices() async {
  await ApiService.init();
  await LangService.instance.init();
  await NotificationService.init();
}

class DefuseApp extends StatelessWidget {
  const DefuseApp({super.key});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<String>(
      valueListenable: LangService.instance.notifier,
      builder: (_, _, _) => MaterialApp(
        title: 'Defuse',
        debugShowCheckedModeBanner: false,
        theme: appTheme(),
        initialRoute: '/',
        routes: {
          '/': (_) => const SplashScreen(),
          '/login': (_) => const LoginScreen(),
          '/home': (_) => const MainScreen(),
          '/lab': (_) => const LabDetailScreen(),
          '/map': (_) => const MapScreen(),
          '/lab-map': (_) => const LabMapScreen(),
          '/wallet': (_) => const WalletScreen(),
          '/wallet-transfer': (_) => const WalletTransferScreen(),
          '/gamer-profile': (_) => const GamerProfileEditScreen(),
          '/friends': (_) => const FriendsScreen(),
          '/friend-profile': (_) => const FriendProfileScreen(),
          '/squad-invite': (_) => const SquadInviteScreen(),
          '/achievements': (_) => const AchievementsScreen(),
          '/stats': (_) => const StatsScreen(),
          '/referral': (_) => const ReferralScreen(),
          '/tournament-detail': (ctx) {
            final args = ModalRoute.of(ctx)?.settings.arguments;
            final id = args is int ? args : int.tryParse(args?.toString() ?? '') ?? 0;
            return TournamentDetailScreen(tournamentId: id);
          },
          '/bookings': (_) => const BookingsScreen(),
          '/my-clubs': (_) => const MyClubsScreen(),
          '/forgot-password': (_) => const ForgotPasswordScreen(),
          '/otp': (ctx) {
            final args = ModalRoute.of(ctx)!.settings.arguments as Map<String, String>;
            return OtpScreen(phone: args['phone']!, mode: args['mode'] ?? 'reset');
          },
          '/new-password': (ctx) {
            final args = ModalRoute.of(ctx)!.settings.arguments as Map<String, String>;
            return NewPasswordScreen(phone: args['phone']!, otp: args['otp']!);
          },
        },
      ),
    );
  }
}
