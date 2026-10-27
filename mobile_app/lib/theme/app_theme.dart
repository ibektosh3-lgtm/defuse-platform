import 'package:flutter/material.dart';

/// Defuse — new "Rounded Modern" color palette (design type 9)
class AppColors {
  // Base
  static const bg = Color(0xFF0B0B0D);       // screen background
  static const bg2 = Color(0xFF0E0E11);       // bottom bar background
  static const panel = Color(0xFF121316);     // card background
  static const panel2 = Color(0xFF16171A);   // inner card
  static const surface = Color(0xFF1E2024);  // separator, divider background

  // Old names (so existing code keeps working)
  static const ink = bg;
  static const ink2 = bg2;
  static const card = panel;
  static const card2 = panel2;

  // Borders
  static const line = Color(0x14FFFFFF);      // rgba(255,255,255,0.08)
  static const line2 = Color(0xFF26282D);     // 1px border
  static const border = line2;

  // Brand — primary
  static const violet = Color(0xFF7040E0);    // oklch(0.58 0.24 295) — primary
  static const violetLight = Color(0xFF9268E8); // oklch(0.68 0.2 295) — link/active

  // Accent colors
  static const green = Color(0xFF78D94B);     // oklch(0.85 0.19 145) — success/income
  static const gold = Color(0xFFD4A020);      // oklch(0.8 0.16 85) — bonus
  static const red = Color(0xFFFF3B4E);       // error
  static const cyan = Color(0xFF27E0FF);      // keep this color (used elsewhere)
  static const lime = green;

  // Old brand names — for existing code
  static const mag = violet;
  static const mag2 = violetLight;
  static const purple = violet;
  static const amber = gold;
  static const orange = gold;
  static const yellow = gold;

  // Text
  static const text = Color(0xFFFFFFFF);
  static const text2 = Color(0xFFC9CCD2);    // secondary text
  static const muted = Color(0xFF8A8F98);    // placeholder, label
  static const faint = Color(0xFF5D626B);    // very faint
  static const text3 = faint;
}

/// Defuse font families — Archivo + JetBrains Mono
class AppFonts {
  static const heading = 'Archivo';      // heading, button
  static const mono = 'ChakraPetch'; // label, meta, code

  static TextStyle label({Color color = AppColors.muted, double size = 11}) =>
      TextStyle(fontFamily: 'ChakraPetch', 
        fontSize: size,
        fontWeight: FontWeight.w500,
        letterSpacing: size * 0.14,
        color: color,
      );

  static TextStyle title({double size = 28, Color color = AppColors.text}) =>
      TextStyle(fontFamily: 'Archivo', 
        fontSize: size,
        fontWeight: FontWeight.w900,
        letterSpacing: -0.02 * size,
        color: color,
        height: 1.1,
      );

  static TextStyle heading17({Color color = AppColors.text}) =>
      TextStyle(fontFamily: 'Archivo', 
        fontSize: 17,
        fontWeight: FontWeight.w700,
        color: color,
      );

  static TextStyle num({double size = 38, Color color = AppColors.text}) =>
      TextStyle(fontFamily: 'Archivo', 
        fontSize: size,
        fontWeight: FontWeight.w900,
        letterSpacing: -0.03 * size,
        color: color,
        height: 1,
      );

  static TextStyle body14({Color color = AppColors.text}) =>
      TextStyle(fontFamily: 'Archivo', fontSize: 14, color: color, height: 1.5);

  static TextStyle body13({Color color = AppColors.muted}) =>
      TextStyle(fontFamily: 'Archivo', fontSize: 13, color: color, height: 1.5);

  static TextStyle button({double size = 15, Color color = Colors.white}) =>
      TextStyle(fontFamily: 'Archivo', 
        fontSize: size,
        fontWeight: FontWeight.w700,
        color: color,
      );

  // Old HudType names — for existing code
  static TextStyle hudLabel({Color color = AppColors.muted, double size = 10.5}) =>
      label(color: color, size: size);
}

/// Old HudType alias — to keep all screens working
class HudType {
  static const display = 'Archivo';
  static const body = 'Archivo';

  static TextStyle hudLabel({Color color = AppColors.muted, double size = 10.5}) =>
      AppFonts.label(color: color, size: size);

  static TextStyle title({double size = 16, Color color = AppColors.text, bool italic = false}) =>
      TextStyle(fontFamily: 'Archivo', 
        fontSize: size,
        fontWeight: FontWeight.w700,
        color: color,
        height: 1.1,
      );

  static TextStyle num({double size = 22, Color color = AppColors.text}) =>
      AppFonts.num(size: size, color: color);

  static TextStyle body14({Color color = AppColors.text}) =>
      AppFonts.body14(color: color);

  static TextStyle bodySmall({Color color = AppColors.muted, double size = 11.5}) =>
      TextStyle(fontFamily: 'Archivo', fontSize: size, color: color);

  static TextStyle button({double size = 13, Color color = Colors.white}) =>
      AppFonts.button(size: size, color: color);
}

ThemeData appTheme() {
  const radius14 = BorderRadius.all(Radius.circular(14));
  const radius15 = BorderRadius.all(Radius.circular(15));

  return ThemeData(
    scaffoldBackgroundColor: AppColors.bg,
    colorScheme: const ColorScheme.dark(
      primary: AppColors.violet,
      secondary: AppColors.violetLight,
      surface: AppColors.panel,
      error: AppColors.red,
    ),
    fontFamily: 'Archivo',
    textTheme: const TextTheme(
      bodyMedium: TextStyle(color: AppColors.text),
      bodySmall: TextStyle(color: AppColors.muted),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(fontFamily: 'Archivo', 
        fontWeight: FontWeight.w700,
        fontSize: 17,
        color: AppColors.text,
      ),
      iconTheme: const IconThemeData(color: AppColors.text),
    ),
    bottomNavigationBarTheme: BottomNavigationBarThemeData(
      backgroundColor: AppColors.bg2,
      selectedItemColor: AppColors.violet,
      unselectedItemColor: AppColors.faint,
      type: BottomNavigationBarType.fixed,
      showSelectedLabels: true,
      showUnselectedLabels: true,
      selectedLabelStyle: TextStyle(fontFamily: 'Archivo', fontSize: 10, fontWeight: FontWeight.w600),
      unselectedLabelStyle: TextStyle(fontFamily: 'Archivo', fontSize: 10),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppColors.panel,
      border: OutlineInputBorder(
        borderRadius: radius14,
        borderSide: const BorderSide(color: AppColors.line2),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: radius14,
        borderSide: const BorderSide(color: AppColors.line2),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: radius14,
        borderSide: const BorderSide(color: AppColors.violet, width: 1.5),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: radius14,
        borderSide: const BorderSide(color: AppColors.red),
      ),
      labelStyle: TextStyle(fontFamily: 'ChakraPetch', 
        color: AppColors.muted,
        fontSize: 11,
        letterSpacing: 0.16 * 11,
      ),
      hintStyle: TextStyle(fontFamily: 'Archivo', color: AppColors.faint),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: AppColors.violet,
        foregroundColor: Colors.white,
        shape: const RoundedRectangleBorder(borderRadius: radius15),
        padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 22),
        textStyle: TextStyle(fontFamily: 'Archivo', 
          fontSize: 15,
          fontWeight: FontWeight.w700,
        ),
        elevation: 0,
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: AppColors.text2,
        side: const BorderSide(color: AppColors.line2),
        shape: const RoundedRectangleBorder(borderRadius: radius15),
        padding: const EdgeInsets.symmetric(vertical: 15, horizontal: 22),
        textStyle: TextStyle(fontFamily: 'Archivo', 
          fontSize: 15,
          fontWeight: FontWeight.w600,
        ),
        elevation: 0,
      ),
    ),
    dividerTheme: const DividerThemeData(
      color: Color(0xFF1B1D21),
      thickness: 1,
      space: 0,
    ),
    cardTheme: const CardThemeData(
      color: AppColors.panel,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(20)),
      ),
    ),
  );
}
