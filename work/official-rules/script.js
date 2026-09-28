// JavaScript Document

$(document).ready(function(){

	// if(localStorage.getItem("testing") !== "true" && $("body").attr("data-page") !== "coming"){
	// 	window.location.replace("/index_aggiornamento.html");
	// }

	$(window).scroll(function() {
		if(!$("#cookie_policy_data").html()){
			$("#cookie_policy").fadeOut(500);
			setCookiePolicyOK();
		}
	});

	var page = $("#page").html();
	if (page == "index"){
		window.fbAsyncInit = function() {
		FB.init({
				appId      : '844890832208013',
				xfbml      : true,
				version    : 'v2.3'
			});
		};


	}
	
	function upFbCard(tit,des,imm){
		alert(tit + " " + des + " " + imm);

		FB.ui({
			method: 'feed',
			name:tit,
			picture:imm,
			link: 'http://bang.dvgiochi.com',
			caption: des,
		}, function(response){});
	}

	resizeDeskMob();
	$(window).resize(function() { resizeDeskMob(); });
	function resizeDeskMob(){
		var screen = $("html").width();
		var mobile = false;
		if (screen < 1024){ mobile = true; } else { mobile = false; }
		
		if (mobile){	
			var h = $(window).height();
			$("#back_mob").css("height",h);
			
			//Mantiene la proporzione delle immagini galleria della sezione prodotto
			var imm_w = $("#top-mob").width();
			var imm_h = imm_w * 9 / 16;
			$("#top-mob").css("height",imm_h);
			
			//Mantiene la proporzione delle immagini galleria della sezione prodotto
			var imm_w = $("#prodotti #gallery .imgs #img-box").width();
			var imm_h = imm_w * 6 / 9;
			$("#prodotti #gallery .imgs #img-box").css("height",imm_h);
			$("#prodotti #gallery .imgs #img-box .row").css("height",imm_h);
			
			$(".r_left").click(function(){
				var n = parseInt($("#img_n").html());
				n = n - 1;
				if (mobile){
					if (n < 0){
						n = 4;
					}
					$(".img-view").fadeOut(0);
					$(".img_" + n).fadeIn(0);
					$("#img_n").html("").html(n);
				}
			});
			$(".r_right").click(function(){
				var n = parseInt($("#img_n").html());
				n = n + 1;
				if (mobile){
					if (n > 4){
						n = 0;
					}
					$(".img-view").fadeOut(0);
					$(".img_" + n).fadeIn(0);
					$("#img_n").html("").html(n);
				}
			});
		} else {
			$("#campionato #login #gio").show();
			$("#campionato #login #org").show();
			$("#tornei").show();
			$(".classifica").show();
			$("#prodotti #descr .imgs #img-box").css("height",500);
		}
	}
	
	//startSite();
	startComingsoon();
	

	$("#main-menu-mob").click(function(){
		$("#main-menu-mob ul").slideToggle(200);
		$("#menu_open").fadeToggle(200);
		$("#menu_close").fadeToggle(200);
	});
	
	$("#refreshcards").click(function(){
		$("#panel-social .content").load("../html/social.php?lang=" + lang);
	});
	
	$("#campionato #info .open").click(function(){
		$("#campionato #info .descr").slideToggle();
	});
	
	$(".selector a").click(function() {
		var selector = "#" + $(this).parent().parent().attr('id');
		$(selector + " a").removeClass("sel");
	 	$(this).toggleClass("sel");
	});
	$("#view_acc_gio").click(function(){
		$("#campionato #login #org").hide();
		$("#campionato #login #gio").show();
	});
	$("#view_acc_org").click(function(){
		$("#campionato #login #gio").hide();
		$("#campionato #login #org").show();
	});
	$("#view_list_tornei").click(function(){
		$(".classifica").hide();
		$("#tornei").show();
	});
	$("#view_list_classifica").click(function(){
		$("#tornei").hide();
		$(".classifica").show();
	});
	
	$("#txt_search_gio_class").keyup(function(){
		var v = $("#txt_search_gio_class").val().replace(" ","_").replace("/","-").replace(".","-").toUpperCase();
		if (v.length >= 3){
			$("#list_gioc .db_data").hide();
			$("#list_gioc " + ' [class*=' + v +']').show();			
		} else {
			$("#list_gioc .db_data").show();
		}
	});
	
	function QuickHelpFilter(){
		var v = $("#txt_search_help").val().replace(" ","_").replace("/","-").replace(".","-").toUpperCase();
		$(".record").remove();
		
		if (v.length >= 3){			
			var val = $("#txt_search_help").val();
			var esp = $("#sel_search_help").val();
			var lang = $("#txt_search_lang").val();
			
			$.post(
				"script/gest_content.php",
				{action:"quickhelp", val:val, esp:esp, lang:lang},
				function(data) {
					$(".record").remove();
					$("#q_result .content").append(data);
					
					var n = 0;
					n = occurrences(data, "record");
					$("#q_result .content .sub").html("parola inserita: " + v + " (" + n + " risultati trovati)");
			
					if (n == 0){
						$("#q_result .content .sub").css("background-color","#F00");
						$("#q_result .content .sub").css("color","#FFF");
					} else{
						$("#q_result .content .sub").removeAttr("style");
						var h = $("#txt_search_help").offset().top - 20;
						$('html,body').animate({ scrollTop: h},'slow');
					}
				},
				"html"
			);
			
		} else {
			$("#q_result .content .sub").removeAttr("style");
			$("#q_result .content .sub").html("nessuna parola inserita");
		}
	}
	
	$("#txt_search_help").keyup(function(){
		QuickHelpFilter();
	});
	
	$("#sel_search_help").change(function(){
		QuickHelpFilter();
	});
	
	$("#filterClassifica").change(function(){
		var regione = $("#filterClassifica").val();
		loadClassifica(4,regione);
		if (regione == ""){
			$(".classifica .filters .tit").html("CLASSIFICA NAZIONALE");
		} else {
			$(".classifica .filters .tit").html("CLASSIFICA " + regione);
		}
	});
	
	$("#pop").click(function(){ $("#pop").fadeOut(200); });
	$("#pop .card").click(function(e) { e.stopPropagation(); });
	
	$("#viewGioClass").click(function(){ $("#viewGioClass").fadeOut(200); });
	$("#viewGioClass .box .content").click(function(e) { e.stopPropagation(); });
	
	$("#albo_doro").click(function(){ $("#viewAlboDoro").fadeIn(200); });
	$("#viewAlboDoro").click(function(){ $("#viewAlboDoro").fadeOut(200); });
	$("#viewAlboDoro .box .content").click(function(e) { e.stopPropagation(); });
	
	$(".card-box").mouseenter(function() {
		$(".card-info", this).show();
	}).mouseleave(function() {
		$(".card-info", this).hide();
	});
	/*
	$(".card-info").click(function() {
		$(".card-descr").show();
	});
	$(".card-descr").click(function() {
		$(".card-descr").hide();
	});
	*/
});

function startSite(){
	var menu_h_scroll = 50;
	var menu_h = parseInt($("#main-menu").css("margin-top"));
	$("#main-menu").css("margin-top", menu_h_scroll + menu_h);
	
	$("#main-menu").animate({ opacity:1},500);
	$("#main-menu").animate({ marginTop:menu_h},800);
}

function startComingsoon(){
	$("#wrapper").animate({ opacity:1},500,function(){
		$("#comingsoon").animate({ opacity:1},500,function(){
			$("#prizes").animate({ opacity:1},500,function(){
				$("#payoff").animate({ opacity:1},500,function(){
					$("#social").animate({ opacity:1},500,function(){
		
					});
				});
			});
		});
	});
}

function scrollProd(img){
	var h = $("#img-box").height();
	var scroll = img * h;
	
	$('#img-box').animate({scrollTop: scroll}, 200);
}

/*
function OpenCard(id){
	$.ajax({
		type: "POST",
		url: "script/gest_card.php",
		dataType: "json",
		data: { action:"open", id:id},
		beforeSend: function(){ $("#pop .card").html(""); },
		success: function(data){
			$("#pop .card").append("<img src='imm/cards/" + data["result"] + "' />" );
			$("#pop").fadeIn(200);
		}
	});
}*/

function SocialShare(id){
/*
	var imm = $(id + " .c_imm").text();
	//$("#fbImg").attr("content",imm);
	var tit = $(id + " .c_tit").text();
	//$("#fbTitle").attr("content",tit);
	var des_it = $(id + " .c_des_it").html();
	var des_en = $(id + " .c_des_en").text();
	//$("#fbDescr").attr("content",des_it);
	FB.ui({
		app_id:2801738249862104,
		method: 'feed',
		display:'popup',
		name:tit,
		source:imm,
		link: 'https://bang.dvgiochi.com',
		quote: des_it,
		description: des_it,
	}, function(response){});
*/
var w = 400;
var h = 250;
var l = Math.floor((screen.width-w)/2);
var t = 10;
	window.open("https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fbang.dvgiochi.com","", "width=" + w + ",height=" + h + ",top=" + t + ",left=" + l + ", status=no, menubar=no, toolbar=no scrollbars=no");	
}

function openGioClass(id,nome){
	var regione = $("#filterClassifica").val();
	$.ajax({
		type: "POST",
		url: "script/gest_account.php",
		dataType: "json",
		data: { action:"dett", id:id, num:4, reg:regione},
		beforeSend: function(){
			$("#viewGioClass .db_data").remove();
		},
		success: function(data){
			$("#viewGioClass .box .content span").text(nome);
			$("#viewGioClass .box .content table").append(data["punteggi"]);
			$("#viewGioClass").fadeIn(200);
		}
	});
}

function closeGioClass(){
	$("#viewGioClass").fadeOut(200);
	$("#viewGioClass .db_data").delay(200).remove();
}

function loadClass(){
	var h_class = $("#list_gioc").outerHeight();
	h_class = h_class + 1326;
	$("#list_gioc").css("max-height",h_class);
}

function occurrences(string, subString, allowOverlapping) {
    string += "";
    subString += "";
    if (subString.length <= 0) return (string.length + 1);
    var n = 0,
        pos = 0,
        step = allowOverlapping ? 1 : subString.length;
    while (true) {
        pos = string.indexOf(subString, pos);
        if (pos >= 0) {
            ++n;
            pos += step;
        } else break;
    }
    return n;
}

function loadClassifica(n_limit, regione){
	var finale = parseInt($("#list_gioc").attr("data-classifica"));

	if(!finale){
		$.ajax({
			type: "POST",
			url: "script/gest_ar.php",
			dataType: "json",
			data: { action:"l_classifica", n_limit:n_limit, regione:regione},
			beforeSend: function(){ 
				$("#list_gioc .db_data").remove();
				$("#list_gioc").append("<li class='record b load'>Caricamento classifica in corso...</li>"); 
			},
			success: function(data){
				$("#list_gioc .load").remove();
				$("#list_gioc").append(data["rows"]);
			}
		});
	}
}

function setCookiePolicyOK(){
	$.ajax({
		type: "POST",
		url: "script/action.php",
		dataType: "json",
		data: { action:"cookie_ok"},
		success: function(data){
			$("#cookie_policy_data").html(data["res"]);
			$("#cookie_policy").fadeOut(500);
		}
	});
}


function OpenCardDescr(id) {
		$("#pop").fadeIn(500);
		$("#pop .box").delay(500).fadeIn(500);
		$("#pop .box #card-descr").delay(500).fadeIn(500);
		$.ajax({
			type: "GET",
			url: "script/open_card.php?lang="+lang+"&id="+id,
			success: function(data){
				$(".carddescr").html(data );
				$("#pop").fadeIn(200);
			}
		});		
		/*
		if($(this).hasClass("gio")){ $("#txt_acc_tipo").val("gio"); }
		if($(this).hasClass("org")){ $("#txt_acc_tipo").val("org"); }
		*/
	}	
